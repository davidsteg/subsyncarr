//! Subsyncarr — automated subtitle synchronization for media libraries.

pub mod anchor;
pub mod changelog;
pub mod config;
pub mod db;
pub mod decide;
pub mod embedded;
pub mod engines;
pub mod events;
pub mod logbuf;
pub mod models;
pub mod processor;
pub mod runlog;
pub mod scanner;
pub mod schedule;
pub mod server;
pub mod settings;
pub mod srt;
pub mod summary;
pub mod video;
pub mod web;

use std::sync::{Arc, RwLock};
use std::time::Duration;

use tracing::{error, info, warn};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Everything the server needs, wired together. Split out of `main` so
/// integration tests can boot the real stack against a temp directory.
pub struct App {
    pub state: Arc<server::AppState>,
}

pub async fn build(cfg: config::Config, logs: logbuf::LogBuffer) -> anyhow::Result<App> {
    let cfg = Arc::new(cfg);
    let db = db::Db::open(&cfg.db_path).await?;
    let n = db.cancel_incomplete_runs().await?;
    if n > 0 {
        info!("Marked {n} incomplete run(s) from a previous session as cancelled");
    }
    let settings = Arc::new(RwLock::new(settings::Settings::resolve(&cfg, &db.all_settings().await?)));
    let log_dir = cfg.db_path.parent().map(|p| p.join("logs")).unwrap_or_else(|| "logs".into());
    let runlogs = runlog::RunLogs::new(log_dir);
    let events = events::EventBus::new(db.clone());
    let processor =
        processor::Processor::new(db.clone(), cfg.clone(), settings.clone(), events.clone(), runlogs.clone());
    let state = server::AppState::new(db, cfg, settings, processor, events, logs, runlogs);
    Ok(App { state })
}

fn warn_misconfigured(cfg: &config::Config, loud: bool) {
    if !cfg.is_scan_path_misconfigured() {
        return;
    }
    if loud {
        let bar = "=".repeat(78);
        warn!(
            "\n{bar}\nWARNING: SCAN_PATHS is not set — falling back to the default \"{}\"\n{bar}\n\
             This path almost certainly does not exist in your container. Every scan\n\
             (manual or scheduled) will find 0 files and silently \"complete\" doing\n\
             nothing.\n\n\
             Fix: set SCAN_PATHS to your actual media mount (e.g. SCAN_PATHS=/media)\n\
             in the container's environment and restart.\n{bar}",
            config::DEFAULT_SCAN_PATH
        );
    } else {
        warn!("Still running with default SCAN_PATHS=\"{}\" — see startup log", config::DEFAULT_SCAN_PATH);
    }
}

async fn cleanup(state: &server::AppState) {
    let r = &state.cfg.retention;
    let db = &state.db;
    match db.trim_old_logs(r.trim_logs_days, r.max_log_size_bytes).await {
        Ok(n) if n > 0 => info!("Trimmed legacy logs for {n} runs"),
        Err(e) => error!("Log trim failed: {e}"),
        _ => {}
    }
    let n = state.runlogs.delete_older_than(r.keep_runs_days);
    if n > 0 {
        info!("Deleted {n} old run log files");
    }
    match db.delete_old_runs(r.keep_runs_days).await {
        Ok(n) if n > 0 => info!("Deleted {n} old runs"),
        Err(e) => error!("Run cleanup failed: {e}"),
        _ => {}
    }
    if let Err(e) = db.vacuum().await {
        error!("Vacuum failed: {e}");
    }
    if let Ok(size) = db.size_bytes().await {
        info!("Database size: {:.2} MB", size as f64 / 1024.0 / 1024.0);
    }
}

/// Background jobs: cron, retention cleanup, startup scan, health log.
pub fn spawn_background(state: Arc<server::AppState>) {
    let cfg = state.cfg.clone();
    if cfg.schedule_enabled() {
        schedule::spawn(cfg.cron_schedule.clone(), state.processor.clone());
    } else {
        info!("Automatic scheduling disabled");
    }

    let s = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let every = Duration::from_secs(s.cfg.retention.cleanup_interval_hours.max(1) * 3600);
        loop {
            info!("Running database cleanup...");
            cleanup(&s).await;
            tokio::time::sleep(every).await;
        }
    });

    // Startup scan: picks up anything added while the container was down and
    // runs the one-time legacy-header cleanup.
    if cfg.startup_scan && !cfg.is_scan_path_misconfigured() {
        let p = state.processor.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            info!("Starting startup scan...");
            if let Err(e) = p.start_run(None, None).await {
                info!("Startup scan not started: {e}");
            }
        });
    }

    let c = cfg.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(300));
        tick.tick().await;
        loop {
            tick.tick().await;
            if let Some(rss) = rss_mb() {
                info!("Memory: RSS={rss:.1}MB");
            }
            warn_misconfigured(&c, false);
        }
    });
}

fn rss_mb() -> Option<f64> {
    let s = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: f64 = s.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * 4096.0 / 1024.0 / 1024.0)
}

pub async fn run() -> anyhow::Result<()> {
    use tracing_subscriber::prelude::*;
    let cfg = config::Config::from_env();
    let logs = logbuf::LogBuffer::new(cfg.server_log_buffer_size);
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_env("LOG_LEVEL")
                .unwrap_or_else(|_| "subsyncarr=info,tower_http=warn,sqlx=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer().with_target(false))
        .with(logs.clone())
        .init();

    info!("Subsyncarr {} starting", env!("CARGO_PKG_VERSION"));
    info!(
        "Scan paths: {:?}, exclude: {:?}",
        cfg.scan.include_paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        cfg.scan.exclude_paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
    );
    warn_misconfigured(&cfg, true);

    let addr = format!("{}:{}", cfg.web_host, cfg.web_port);
    let app = build(cfg, logs).await?;
    spawn_background(app.state.clone());

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Subsyncarr UI available at http://{addr}");
    let state = app.state.clone();
    axum::serve(listener, server::router(app.state))
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
            tokio::select! {
                _ = term.recv() => {},
                _ = tokio::signal::ctrl_c() => {},
            }
            info!("Shutdown signal received, shutting down gracefully...");
        })
        .await?;
    // Kill in-flight engines and record the run as cancelled.
    let _ = state.processor.stop_run().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    state.runlogs.end();
    state.db.close().await;
    Ok(())
}
