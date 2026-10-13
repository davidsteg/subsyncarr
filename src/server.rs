//! HTTP API + WebSocket + embedded UI. See docs/API.md for the contract.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::compression::CompressionLayer;
use tracing::{error, info};

use crate::config::Config;
use crate::db::Db;
use crate::events::EventBus;
use crate::integrations::webhook::{self, TriggerQueue};
use crate::integrations::{self, media, notify, PathMap};
use crate::logbuf::{self, LogBuffer};
use crate::models::FileStatus;
use crate::processor::{Processor, RunError};
use crate::runlog::RunLogs;
use crate::settings::{normalize_updates, Settings};
use crate::summary::LAST_RUN_SUMMARY;
use crate::{changelog, schedule, web};

pub const REPO: &str = "davidsteg/subsyncarr";
const STATS_TTL: Duration = Duration::from_secs(10);

pub struct AppState {
    pub db: Db,
    pub cfg: Arc<Config>,
    pub settings: Arc<RwLock<Settings>>,
    pub processor: Arc<Processor>,
    pub events: EventBus,
    pub logs: LogBuffer,
    pub runlogs: RunLogs,
    pub webhooks: TriggerQueue,
    stats_cache: Mutex<Option<(Instant, u64, Value)>>,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db: Db,
        cfg: Arc<Config>,
        settings: Arc<RwLock<Settings>>,
        processor: Arc<Processor>,
        events: EventBus,
        logs: LogBuffer,
        runlogs: RunLogs,
        webhooks: TriggerQueue,
    ) -> Arc<Self> {
        Arc::new(AppState {
            db,
            cfg,
            settings,
            processor,
            events,
            logs,
            runlogs,
            webhooks,
            stats_cache: Mutex::new(None),
        })
    }

    pub fn invalidate_stats(&self) {
        *self.stats_cache.lock().unwrap() = None;
    }
}

type S = State<Arc<AppState>>;

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        error!("database error: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "query failed".into())
    }
}

type ApiResult<T = Json<Value>> = Result<T, ApiError>;

fn not_found(what: &str) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, format!("{what} not found"))
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/version", get(version))
        .route("/api/config", get(config))
        .route("/api/changelog", get(|| async { Json(changelog::entries()) }))
        .route("/api/stats", get(stats))
        .route("/api/folders", get(folders))
        .route("/api/status", get(status))
        .route("/api/history", get(history))
        .route("/api/runs/{id}", get(run_detail))
        .route("/api/runs/{id}/files", get(run_files))
        .route("/api/runs/{id}/logs", get(run_logs))
        .route("/api/logs", get(server_logs))
        .route("/api/run/start", post(start_run))
        .route("/api/run/stop", post(stop_run))
        .route("/api/file/skip", post(skip_file))
        .route("/api/files/clear", post(|| async { Json(json!({ "success": true })) }))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/skip-status", get(skip_status))
        .route("/api/skip-status/reset", post(reset_skip))
        .route("/api/skip-status/{*path}", get(skip_status_file))
        .route("/api/media", get(media_query))
        .route("/api/media/{*path}", get(media_path))
        .route("/api/settings", get(get_settings).post(post_settings))
        .route("/api/integrations/test", post(test_integration))
        .route(
            "/api/webhook",
            post(|s: S, q: Query<WebhookQ>, h: HeaderMap, b: Bytes| webhook_in(s, AxPath("generic".into()), q, h, b)),
        )
        .route("/api/webhook/{source}", post(webhook_in))
        .route("/ws", get(ws_upgrade))
        .fallback(web::static_handler)
        .layer(CompressionLayer::new())
        .with_state(state)
}

// ------------------------------------------------------------------ reads

async fn version() -> Json<Value> {
    let v = env!("CARGO_PKG_VERSION");
    Json(json!({
        "version": v,
        "repo": REPO,
        "releaseUrl": format!("https://github.com/{REPO}/releases/tag/{v}"),
    }))
}

async fn config(State(s): S) -> Json<Value> {
    let c = &s.cfg;
    let enabled = c.schedule_enabled();
    Json(json!({
        "paths": c.scan.include_paths,
        "excludePaths": c.scan.exclude_paths,
        "isConfigured": !c.is_scan_path_misconfigured(),
        "schedule": {
            "enabled": enabled,
            "cron": c.cron_schedule,
            "description": if enabled { schedule::describe(&c.cron_schedule) } else { String::new() },
            "nextRun": if enabled { schedule::next_run(&c.cron_schedule).map(|d| d.timestamp_millis()) } else { None },
        },
    }))
}

async fn stats(State(s): S) -> ApiResult {
    let generation = s.events.generation();
    if let Some((at, g, v)) = s.stats_cache.lock().unwrap().as_ref() {
        if at.elapsed() < STATS_TTL && *g == generation {
            return Ok(Json(v.clone()));
        }
    }
    let v = s.db.media_stats().await?;
    *s.stats_cache.lock().unwrap() = Some((Instant::now(), generation, v.clone()));
    Ok(Json(v))
}

#[derive(Deserialize)]
struct FolderQ {
    parent: Option<String>,
}

async fn folders(State(s): S, Query(q): Query<FolderQ>) -> ApiResult {
    Ok(Json(json!(s.db.folder_stats(q.parent.as_deref()).await?)))
}

#[derive(Deserialize)]
struct StatusQ {
    brief: Option<String>,
    limit: Option<i64>,
}

async fn status(State(s): S, Query(q): Query<StatusQ>) -> ApiResult {
    let brief = q.brief.as_deref() == Some("true");
    let run = s.processor.current_run().await;
    let (files, total) = match (&run, brief) {
        (Some(r), false) => {
            let limit = q.limit.unwrap_or(100).clamp(1, 1000);
            (s.db.active_and_recent_files(&r.id, limit).await?, r.total_files)
        }
        _ => (Vec::new(), 0),
    };
    let active = s.processor.current();
    Ok(Json(json!({
        "currentRun": run,
        "scanProgress": s.processor.scan_progress(),
        "files": files,
        "totalFiles": total,
        "isRunning": active.is_some(),
        "dryRun": active.map(|r| r.dry_run).unwrap_or(false),
    })))
}

#[derive(Deserialize)]
struct LimitQ {
    limit: Option<i64>,
}

async fn history(State(s): S, Query(q): Query<LimitQ>) -> ApiResult {
    Ok(Json(json!(s.db.run_history(q.limit.unwrap_or(50).clamp(1, 1000)).await?)))
}

async fn run_detail(State(s): S, AxPath(id): AxPath<String>, Query(q): Query<LimitQ>) -> ApiResult {
    let run = s.db.get_run(&id).await?.ok_or_else(|| not_found("Run"))?;
    let (files, total) = s.db.files_paginated(&id, q.limit.unwrap_or(500).clamp(1, 5000), 0, None).await?;
    Ok(Json(json!({ "run": run, "files": files, "totalFiles": total })))
}

#[derive(Deserialize)]
struct FilesQ {
    status: Option<String>,
    page: Option<i64>,
    limit: Option<i64>,
}

async fn run_files(State(s): S, AxPath(id): AxPath<String>, Query(q): Query<FilesQ>) -> ApiResult {
    s.db.get_run(&id).await?.ok_or_else(|| not_found("Run"))?;
    let status = q.status.as_deref().and_then(FileStatus::parse).map(|s| s.as_str());
    let page = q.page.unwrap_or(1).max(1);
    let limit = q.limit.unwrap_or(500).clamp(1, 5000);
    let (files, total) = s.db.files_paginated(&id, limit, (page - 1) * limit, status).await?;
    Ok(Json(json!({
        "files": files,
        "total": total,
        "page": page,
        "limit": limit,
        "totalPages": (total + limit - 1) / limit,
    })))
}

async fn run_logs(State(s): S, AxPath(id): AxPath<String>) -> ApiResult {
    s.db.get_run(&id).await?.ok_or_else(|| not_found("Run"))?;
    Ok(Json(json!({ "logs": s.runlogs.read(&id) })))
}

#[derive(Deserialize)]
struct LogsQ {
    limit: Option<usize>,
    level: Option<String>,
    search: Option<String>,
    since: Option<u64>,
    format: Option<String>,
}

async fn server_logs(State(s): S, Query(q): Query<LogsQ>) -> Response {
    let level = q.level.as_deref().filter(|l| ["all", "log", "warn", "error"].contains(l));
    let entries = s.logs.query(&logbuf::Query {
        limit: q.limit.unwrap_or(500).clamp(1, 5000),
        level,
        search: q.search.as_deref().filter(|s| !s.is_empty()),
        since: q.since,
    });
    if q.format.as_deref() == Some("text") {
        let text: String = entries
            .iter()
            .map(|e| {
                let ts = chrono::DateTime::from_timestamp_millis(e.timestamp).unwrap_or_default();
                format!("[{}] {}: {}\n", ts.format("%Y-%m-%dT%H:%M:%S%.3fZ"), e.level.to_uppercase(), e.message)
            })
            .collect();
        return ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response();
    }
    let (size, max, latest) = s.logs.info();
    Json(json!({ "size": size, "maxSize": max, "latestSeq": latest, "logs": entries })).into_response()
}

#[derive(Deserialize)]
struct DiagQ {
    limit: Option<i64>,
}

/// Why subtitles aren't syncing: the last run's per-reason summary plus files
/// with strikes, permanently skipped engines and parked forced subs.
async fn diagnostics(State(s): S, Query(q): Query<DiagQ>) -> ApiResult {
    let limit = q.limit.unwrap_or(200).clamp(1, 2000);
    let mut v = s.db.diagnostics(limit).await?;
    let last: Value =
        s.db.all_settings()
            .await?
            .get(LAST_RUN_SUMMARY)
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or(Value::Null);
    v["lastRunSummary"] = last;
    Ok(Json(v))
}

async fn skip_status(State(s): S) -> ApiResult {
    Ok(Json(s.db.failure_stats().await?))
}

fn abs_path(p: &str) -> String {
    if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{p}")
    }
}

async fn skip_status_file(State(s): S, AxPath(path): AxPath<String>) -> ApiResult {
    let path = abs_path(&path);
    Ok(Json(json!({ "filePath": path, "skippedEngines": s.db.skipped_engines(&path).await? })))
}

#[derive(Deserialize)]
struct MediaQ {
    path: String,
}

async fn media_query(State(s): S, Query(q): Query<MediaQ>) -> ApiResult {
    Ok(Json(s.db.media_detail(&q.path).await?))
}

async fn media_path(State(s): S, AxPath(path): AxPath<String>) -> ApiResult {
    Ok(Json(s.db.media_detail(&abs_path(&path)).await?))
}

async fn get_settings(State(s): S) -> Json<Value> {
    let st = s.settings.read().unwrap().clone();
    let mut v = serde_json::to_value(&st).unwrap_or_default();
    if let Value::Object(m) = &mut v {
        m.insert("cronSchedule".into(), json!(s.cfg.cron_schedule));
        m.insert("includeEngines".into(), json!(s.cfg.include_engines.join(",")));
    }
    Json(v)
}

// ---------------------------------------------------------------- control

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBody {
    paths: Option<Vec<String>>,
    dry_run: Option<bool>,
}

async fn start_run(State(s): S, body: Option<Json<StartBody>>) -> ApiResult {
    let body = body.map(|b| b.0).unwrap_or(StartBody { paths: None, dry_run: None });
    let paths: Option<Vec<PathBuf>> = body.paths.map(|v| {
        v.into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| p.starts_with('/') && !p.contains(".."))
            .map(PathBuf::from)
            .collect()
    });
    info!(
        "POST /api/run/start{}{}",
        paths.as_ref().map(|p| format!(" (custom paths: {p:?})")).unwrap_or_else(|| " (default paths)".into()),
        if body.dry_run == Some(true) { " [DRY RUN]" } else { "" }
    );
    // Explicit dryRun:true forces a dry run; otherwise the saved setting.
    let dry = if body.dry_run == Some(true) { Some(true) } else { None };
    match s.processor.start_run(paths, dry).await {
        Ok(id) => Ok(Json(json!({ "runId": id }))),
        Err(RunError::AlreadyRunning) => Err(ApiError(StatusCode::CONFLICT, RunError::AlreadyRunning.to_string())),
        Err(e) => Err(ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

async fn stop_run(State(s): S) -> ApiResult {
    info!("POST /api/run/stop");
    match s.processor.stop_run().await {
        Ok(()) => {
            s.invalidate_stats();
            Ok(Json(json!({ "success": true })))
        }
        Err(e) => Err(ApiError(StatusCode::CONFLICT, e.to_string())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileBody {
    file_path: Option<String>,
    engine: Option<String>,
}

async fn skip_file(State(s): S, Json(b): Json<FileBody>) -> ApiResult {
    let p = b.file_path.ok_or(ApiError(StatusCode::BAD_REQUEST, "filePath required".into()))?;
    s.processor.skip_file(std::path::Path::new(&p));
    Ok(Json(json!({ "success": true })))
}

async fn reset_skip(State(s): S, Json(b): Json<FileBody>) -> ApiResult {
    let p = b.file_path.ok_or(ApiError(StatusCode::BAD_REQUEST, "filePath required".into()))?;
    info!("POST /api/skip-status/reset - {p}{}", b.engine.as_ref().map(|e| format!(" ({e})")).unwrap_or_default());
    s.db.reset_engine_skip(&p, b.engine.as_deref()).await?;
    s.invalidate_stats();
    Ok(Json(json!({ "success": true })))
}

async fn post_settings(State(s): S, Json(body): Json<Value>) -> ApiResult {
    let Value::Object(map) = body else {
        return Err(ApiError(StatusCode::BAD_REQUEST, "expected a JSON object".into()));
    };
    let updates = normalize_updates(&map);
    s.db.set_settings(&updates).await?;
    let all: HashMap<String, String> = s.db.all_settings().await?;
    *s.settings.write().unwrap() = Settings::resolve(&s.cfg, &all);
    s.invalidate_stats();
    info!("Settings updated: {}", updates.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "));
    Ok(Json(json!({ "success": true, "applied": updates.len() })))
}

// ----------------------------------------------------------- integrations

#[derive(Deserialize)]
struct WebhookQ {
    token: Option<String>,
    path: Option<String>,
    apikey: Option<String>,
}

/// Token from `?token=`/`?apikey=`, `X-Api-Key`, `Authorization: Bearer`
/// or the password of Basic auth (Sonarr/Radarr's username/password).
fn webhook_token(q: &WebhookQ, h: &HeaderMap) -> Option<String> {
    if let Some(t) = q.token.clone().or_else(|| q.apikey.clone()) {
        return Some(t);
    }
    let header = |name: &str| h.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    if let Some(k) = header("x-api-key") {
        return Some(k.to_string());
    }
    let auth = header("authorization")?;
    if let Some(t) = auth.strip_prefix("Bearer ") {
        return Some(t.trim().to_string());
    }
    let b64 = auth.strip_prefix("Basic ")?;
    let decoded = base64_decode(b64.trim())?;
    let (_, pass) = decoded.split_once(':')?;
    Some(pass.to_string())
}

fn base64_decode(s: &str) -> Option<String> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = Vec::new();
    for c in s.bytes().filter(|&c| c != b'=') {
        bits = (bits << 6) | A.iter().position(|&a| a == c)? as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    String::from_utf8(out).ok()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Body as JSON, or a form (`curl --data-urlencode path=…`) read as an object.
fn webhook_body(h: &HeaderMap, body: &[u8]) -> Value {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Value::Null;
    }
    let form = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("application/x-www-form-urlencoded"));
    if !form {
        if let Ok(v) = serde_json::from_slice(body) {
            return v;
        }
    }
    let map: serde_json::Map<String, Value> =
        form_urlencoded::parse(body).map(|(k, v)| (k.into_owned(), Value::String(v.into_owned()))).collect();
    Value::Object(map)
}

async fn webhook_in(
    State(s): S,
    AxPath(source): AxPath<String>,
    Query(q): Query<WebhookQ>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    if !webhook::SOURCES.contains(&source.as_str()) {
        return Err(not_found("Webhook source"));
    }
    let cfg = s.settings.read().unwrap().integrations.clone();
    if !cfg.webhook_enabled {
        return Err(ApiError(StatusCode::FORBIDDEN, "webhooks are disabled in Settings".into()));
    }
    if !cfg.webhook_token.is_empty() && !webhook_token(&q, &headers).is_some_and(|t| same(&t, &cfg.webhook_token)) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid or missing webhook token".into()));
    }
    let request = match q.path.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(p) => webhook::Request::Paths(vec![p.to_string()]),
        None => webhook::parse(&webhook_body(&headers, &body)),
    };
    let raw = match request {
        webhook::Request::Test => {
            info!("Webhook test from {source}");
            return Ok(Json(json!({ "ok": true, "message": "Subsyncarr received the test" })));
        }
        webhook::Request::Ignored(why) => return Ok(Json(json!({ "ok": true, "ignored": why }))),
        webhook::Request::Paths(p) => p,
    };
    let map = PathMap::parse_lossy(&cfg.webhook_path_map);
    let scan = s.cfg.scan.clone();
    let (queued, errors) = tokio::task::spawn_blocking(move || {
        let mut queued = Vec::new();
        let mut errors = Vec::new();
        for r in &raw {
            match webhook::resolve(r, &map, &scan) {
                Ok(p) => queued.extend(p),
                Err(e) => errors.push(e),
            }
        }
        (queued, errors)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    for e in &errors {
        info!("Webhook from {source}: {e}");
    }
    if queued.is_empty() && !errors.is_empty() {
        return Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, errors.join("; ")));
    }
    info!("Webhook from {source}: queued {} path{} for sync", queued.len(), if queued.len() == 1 { "" } else { "s" });
    let paths: Vec<String> = queued.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    s.webhooks.push(queued);
    Ok(Json(json!({ "ok": true, "queued": paths, "errors": errors })))
}

#[derive(Deserialize)]
struct TestBody {
    target: String,
}

async fn test_integration(State(s): S, Json(b): Json<TestBody>) -> ApiResult {
    let cfg = s.settings.read().unwrap().integrations.clone();
    let client = integrations::http_client();
    let result = match b.target.as_str() {
        "notify" => {
            notify::send(&client, &cfg, &notify::Message::test()).await.map(|()| "Test notification sent".into())
        }
        "media" => media::test(&client, &cfg).await,
        _ => return Err(ApiError(StatusCode::BAD_REQUEST, "target must be notify or media".into())),
    };
    match result {
        Ok(message) => Ok(Json(json!({ "ok": true, "message": message }))),
        Err(e) => Err(ApiError(StatusCode::BAD_GATEWAY, format!("{e:#}"))),
    }
}

// -------------------------------------------------------------- websocket

async fn ws_upgrade(State(s): S, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| ws_client(s, socket))
}

async fn ws_client(s: Arc<AppState>, socket: WebSocket) {
    let mut rx = s.events.subscribe();
    let (mut tx, mut inbound) = socket.split();
    let active = s.processor.current();
    let hello = json!({
        "type": "state",
        "data": {
            "currentRun": s.processor.current_run().await,
            "isRunning": active.is_some(),
            "dryRun": active.map(|r| r.dry_run).unwrap_or(false),
            "scanProgress": s.processor.scan_progress(),
        }
    });
    if tx.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }
    info!("WebSocket client connected (total: {})", s.events.client_count());
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(payload) => {
                    if tx.send(Message::Text(payload.as_ref().into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            incoming = inbound.next() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = ping.tick() => {
                if tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }
    info!("WebSocket client disconnected (total: {})", s.events.client_count().saturating_sub(1));
}
