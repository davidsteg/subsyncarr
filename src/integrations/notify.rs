//! Run notifications: one message per finished run, sent to an Apprise API
//! endpoint, a Discord webhook or any URL accepting JSON.

use serde_json::{json, Value};
use tracing::info;

use super::check;
use crate::models::Run;
use crate::settings::Integrations;

/// Failed / not-fitting files named in a message; the rest are counted.
pub const MAX_LISTED: usize = 10;
const DISCORD_DESCRIPTION_MAX: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Info,
    Warning,
    Failure,
}

impl Level {
    fn apprise(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warning => "warning",
            Level::Failure => "failure",
        }
    }

    fn discord_color(self) -> u32 {
        match self {
            Level::Info => 0x2e9d5b,
            Level::Warning => 0xd9a514,
            Level::Failure => 0xd64545,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Message {
    pub event: &'static str,
    pub title: String,
    pub body: String,
    pub level: Level,
    pub run: Option<Run>,
    pub problems: Vec<(String, String)>,
}

fn file_name(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

fn duration(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m {}s", s / 60, s % 60),
        _ => format!("{}h {}m", s / 3600, s % 3600 / 60),
    }
}

impl Message {
    pub fn test() -> Self {
        Message {
            event: "test",
            title: "Subsyncarr test notification".into(),
            body: "Notifications are set up correctly.".into(),
            level: Level::Info,
            run: None,
            problems: Vec::new(),
        }
    }

    /// `problems` is (path, status) of failed and not-fitting files.
    pub fn run_summary(run: &Run, problems: &[(String, String)]) -> Self {
        let issues = run.failed + run.not_fitting;
        let level = match (issues, run.completed) {
            (0, _) => Level::Info,
            (_, 0) => Level::Failure,
            _ => Level::Warning,
        };
        let took = run.end_time.map(|e| format!(" in {}", duration(e - run.start_time))).unwrap_or_default();
        let mut body = format!(
            "Synced {}, not fitting {}, failed {}, skipped {} of {} file{}{took}.",
            run.completed,
            run.not_fitting,
            run.failed,
            run.skipped,
            run.total_files,
            if run.total_files == 1 { "" } else { "s" },
        );
        if !problems.is_empty() {
            body.push('\n');
            for (path, status) in problems.iter().take(MAX_LISTED) {
                let label = if status == "not_fitting" { "not fitting" } else { "failed" };
                body.push_str(&format!("\n• {label}: {}", file_name(path)));
            }
            let more = issues - problems.len().min(MAX_LISTED) as i64;
            if more > 0 {
                body.push_str(&format!("\n…and {more} more"));
            }
        }
        let title = format!(
            "{}Subsyncarr run {}",
            if run.dry_run { "[Dry run] " } else { "" },
            if issues > 0 { "finished with problems" } else { "finished" }
        );
        Message { event: "run.completed", title, body, level, run: Some(run.clone()), problems: problems.to_vec() }
    }
}

/// Whether a finished run is worth a message under the configured filter.
pub fn wanted(cfg: &Integrations, run: &Run) -> bool {
    if cfg.notify_url.is_empty() {
        return false;
    }
    let issues = run.failed + run.not_fitting;
    match cfg.notify_on.as_str() {
        "always" => true,
        "issues" => issues > 0,
        _ => run.completed + issues > 0,
    }
}

pub fn payload(kind: &str, m: &Message) -> Value {
    match kind {
        "discord" => {
            let mut desc: String = m.body.chars().take(DISCORD_DESCRIPTION_MAX).collect();
            if m.body.chars().count() > DISCORD_DESCRIPTION_MAX {
                desc.push('…');
            }
            json!({
                "username": "Subsyncarr",
                "embeds": [{ "title": m.title, "description": desc, "color": m.level.discord_color() }],
            })
        }
        "json" => json!({
            "event": m.event,
            "title": m.title,
            "body": m.body,
            "level": m.level.apprise(),
            "run": m.run,
            "problems": m.problems.iter().map(|(p, s)| json!({ "path": p, "status": s })).collect::<Vec<_>>(),
        }),
        _ => json!({ "title": m.title, "body": m.body, "type": m.level.apprise(), "format": "text" }),
    }
}

pub async fn send(client: &reqwest::Client, cfg: &Integrations, m: &Message) -> anyhow::Result<()> {
    if cfg.notify_url.is_empty() {
        anyhow::bail!("no notification URL configured");
    }
    let res = client.post(&cfg.notify_url).json(&payload(&cfg.notify_kind, m)).send().await?;
    check(res).await?;
    info!("Notification sent ({}): {}", cfg.notify_kind, m.title);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(completed: i64, failed: i64, not_fitting: i64) -> Run {
        Run {
            id: "r".into(),
            start_time: 0,
            end_time: Some(192_000),
            total_files: completed + failed + not_fitting,
            completed,
            skipped: 0,
            failed,
            not_fitting,
            total_engines: 0,
            completed_engines: 0,
            status: "completed".into(),
            engine_stats: Default::default(),
            anchors_completed: 0,
            followers_completed: 0,
            dry_run: false,
        }
    }

    fn cfg(on: &str) -> Integrations {
        Integrations { notify_url: "http://x".into(), notify_on: on.into(), ..Default::default() }
    }

    #[test]
    fn filter_follows_setting() {
        assert!(!wanted(&cfg("changes"), &run(0, 0, 0)));
        assert!(wanted(&cfg("changes"), &run(1, 0, 0)));
        assert!(wanted(&cfg("always"), &run(0, 0, 0)));
        assert!(!wanted(&cfg("issues"), &run(5, 0, 0)));
        assert!(wanted(&cfg("issues"), &run(5, 0, 1)));
        assert!(!wanted(&Integrations { notify_url: String::new(), ..cfg("always") }, &run(1, 0, 0)));
    }

    #[test]
    fn summary_lists_problems() {
        let problems: Vec<(String, String)> = (0..12)
            .map(|i| (format!("/media/Show/e{i}.en.srt"), if i % 2 == 0 { "error" } else { "not_fitting" }.into()))
            .collect();
        let m = Message::run_summary(&run(3, 6, 6), &problems);
        assert_eq!(m.level, Level::Warning);
        assert!(m.title.contains("problems"));
        assert!(m.body.starts_with("Synced 3, not fitting 6, failed 6, skipped 0 of 15 files in 3m 12s."));
        assert!(m.body.contains("• failed: e0.en.srt"));
        assert!(m.body.contains("• not fitting: e1.en.srt"));
        assert!(m.body.ends_with("…and 2 more"));
        assert_eq!(Message::run_summary(&run(0, 1, 0), &[]).level, Level::Failure);
    }

    #[test]
    fn payload_shapes() {
        let m = Message::test();
        assert_eq!(payload("apprise", &m)["type"], "info");
        assert_eq!(payload("discord", &m)["embeds"][0]["title"], m.title);
        assert_eq!(payload("json", &m)["event"], "test");
    }
}
