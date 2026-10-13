//! Per-run tally of what happened to every subtitle and why. Logged at the
//! end of each run, so the run log answers "why wasn't X synced?" without
//! reading thousands of lines, and stored for `/api/diagnostics`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::models::EngineResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Synced,
    SyncedSingleEngine,
    AlreadyInSync,
    NotFittingDisagree,
    NotFittingShift,
    NotFittingUnconfirmed,
    Deleted,
    ForcedKept,
    ForcedParked,
    FailedTimeout,
    FailedError,
    FailedEnginesSkipped,
    NoVideo,
    Cancelled,
}

impl Category {
    pub const ALL: [Category; 14] = [
        Category::Synced,
        Category::SyncedSingleEngine,
        Category::AlreadyInSync,
        Category::NotFittingDisagree,
        Category::NotFittingShift,
        Category::NotFittingUnconfirmed,
        Category::Deleted,
        Category::ForcedKept,
        Category::ForcedParked,
        Category::FailedTimeout,
        Category::FailedError,
        Category::FailedEnginesSkipped,
        Category::NoVideo,
        Category::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Category::Synced => "synced",
            Category::SyncedSingleEngine => "synced_single_engine",
            Category::AlreadyInSync => "already_in_sync",
            Category::NotFittingDisagree => "not_fitting_disagree",
            Category::NotFittingShift => "not_fitting_shift",
            Category::NotFittingUnconfirmed => "not_fitting_unconfirmed",
            Category::Deleted => "deleted",
            Category::ForcedKept => "forced_kept",
            Category::ForcedParked => "forced_parked",
            Category::FailedTimeout => "failed_timeout",
            Category::FailedError => "failed_error",
            Category::FailedEnginesSkipped => "failed_engines_skipped",
            Category::NoVideo => "no_video",
            Category::Cancelled => "cancelled",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Category::Synced => "synced (both engines agree)",
            Category::SyncedSingleEngine => "synced (only one engine produced output)",
            Category::AlreadyInSync => "already in sync (ffsubsync shift under 1 s), left unchanged",
            Category::NotFittingDisagree => "not fitting: engines disagree (strike)",
            Category::NotFittingShift => "not fitting: shift too large (strike)",
            Category::NotFittingUnconfirmed => "not fitting: only one engine wants a large shift (no strike)",
            Category::Deleted => "deleted after repeated not-fitting strikes",
            Category::ForcedKept => "forced sub not fitting, kept unchanged",
            Category::ForcedParked => "forced sub parked until the file changes",
            Category::FailedTimeout => "failed: engine timeout (no strike)",
            Category::FailedError => "failed: engine error (no strike)",
            Category::FailedEnginesSkipped => "failed: all engines skipped after 3+ failures",
            Category::NoVideo => "no matching video file",
            Category::Cancelled => "cancelled",
        }
    }

    /// Worth listing file by file in the summary.
    fn is_problem(self) -> bool {
        !matches!(self, Category::Synced | Category::SyncedSingleEngine | Category::AlreadyInSync | Category::Cancelled)
    }
}

const MAX_SAMPLES: usize = 25;

/// Settings-table key the last run's summary is stored under.
pub const LAST_RUN_SUMMARY: &str = "last_run_summary";

/// What one engine did for one file.
#[derive(Debug, Clone)]
pub struct Attempt {
    pub engine: String,
    /// `ok`, `shift`, `timeout`, `skipped`, `no_output` or `error`.
    pub status: &'static str,
    pub shift_ms: Option<i64>,
    pub detail: Option<String>,
}

impl Attempt {
    pub fn ok(engine: &str, shift_ms: i64) -> Self {
        Attempt { engine: engine.into(), status: "ok", shift_ms: Some(shift_ms), detail: None }
    }

    pub fn failed(engine: &str, r: &EngineResult) -> Self {
        let status = classify_failure(r);
        let detail = match status {
            "skipped" => None,
            "shift" => r.original_shift_ms.map(|s| format!("{s}ms")),
            _ => Some(failure_detail(&r.message, r.stderr.as_deref())),
        };
        Attempt { engine: engine.into(), status, shift_ms: None, detail }
    }
}

/// A short, greppable reason for a failed engine result.
pub fn classify_failure(r: &EngineResult) -> &'static str {
    let msg = r.message.to_lowercase();
    if r.shift_too_large {
        "shift"
    } else if r.skipped {
        "skipped"
    } else if msg.contains("timeout") || msg.contains("timed out") {
        "timeout"
    } else if ["no parseable", "did not produce", "produced no output", "empty or unparseable"]
        .iter()
        .any(|p| msg.contains(p))
    {
        "no_output"
    } else {
        "error"
    }
}

/// The engine's last stderr line (what actually went wrong) when there is
/// one, else the wrapper's message.
pub fn failure_detail(message: &str, stderr: Option<&str>) -> String {
    let last = stderr.unwrap_or("").lines().map(str::trim).rfind(|l| !l.is_empty());
    last.unwrap_or(message).chars().take(200).collect()
}

/// Category when no engine produced an alignment and none reported a mismatch.
pub fn failure_category(attempts: &[Attempt]) -> Category {
    if !attempts.is_empty() && attempts.iter().all(|a| a.status == "skipped") {
        Category::FailedEnginesSkipped
    } else if attempts.iter().any(|a| a.status == "timeout") {
        Category::FailedTimeout
    } else {
        Category::FailedError
    }
}

/// `alass ✓ +1200ms, ffsubsync ✗ timeout (…)`
pub fn format_attempts(attempts: &[Attempt]) -> String {
    attempts
        .iter()
        .map(|a| match (a.status, a.shift_ms) {
            ("ok", Some(s)) => format!("{} ✓ {s:+}ms", a.engine),
            _ => match &a.detail {
                Some(d) => format!("{} ✗ {} ({d})", a.engine, a.status),
                None => format!("{} ✗ {}", a.engine, a.status),
            },
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub found: usize,
    pub need_sync: usize,
    pub already_synced: usize,
    pub parked: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub dry_run: bool,
    pub scan: ScanStats,
    pub counts: BTreeMap<Category, usize>,
    pub samples: BTreeMap<Category, Vec<String>>,
}

impl RunSummary {
    pub fn new(run_id: &str, dry_run: bool) -> Self {
        RunSummary {
            run_id: run_id.into(),
            started_at: crate::now_ms(),
            finished_at: None,
            dry_run,
            scan: ScanStats::default(),
            counts: BTreeMap::new(),
            samples: BTreeMap::new(),
        }
    }

    pub fn record(&mut self, c: Category, file_path: &str, detail: &str) {
        *self.counts.entry(c).or_default() += 1;
        if c.is_problem() {
            let list = self.samples.entry(c).or_default();
            if list.len() < MAX_SAMPLES {
                list.push(if detail.is_empty() { file_path.into() } else { format!("{file_path} — {detail}") });
            }
        }
    }

    pub fn count(&self, c: Category) -> usize {
        self.counts.get(&c).copied().unwrap_or(0)
    }

    /// Human-readable block for the run log.
    pub fn format(&self) -> Vec<String> {
        let s = &self.scan;
        let mut lines = vec!["===== Run summary =====".to_string()];
        lines.push(format!(
            "Scan: {} subtitle(s) found, {} needed sync, {} already synced{}",
            s.found,
            s.need_sync,
            s.already_synced,
            if s.parked > 0 { format!(" (incl. {} parked forced sub(s))", s.parked) } else { String::new() }
        ));
        let non_zero: Vec<Category> = Category::ALL.into_iter().filter(|c| self.count(*c) > 0).collect();
        if non_zero.is_empty() {
            lines.push("No subtitles were processed.".into());
        }
        for c in &non_zero {
            lines.push(format!("  {:>6}  {}", self.count(*c), c.label()));
        }
        for c in Category::ALL.into_iter().filter(|c| c.is_problem()) {
            let Some(list) = self.samples.get(&c).filter(|l| !l.is_empty()) else {
                continue;
            };
            let total = self.count(c);
            let shown =
                if total > list.len() { format!("{total}, first {} shown", list.len()) } else { total.to_string() };
            lines.push(format!("-- {} ({shown}):", c.label()));
            lines.extend(list.iter().map(|p| format!("   {p}")));
        }
        lines.push("=======================".into());
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_and_formats() {
        let timeout = EngineResult { message: "Timeout: alass took longer than 300s".into(), ..Default::default() };
        let crash = EngineResult {
            message: "Error processing x: ffsubsync exited with code 1".into(),
            stderr: Some("loading\ncould not decode audio\n".into()),
            ..Default::default()
        };
        let shift = EngineResult { shift_too_large: true, original_shift_ms: Some(42000), ..Default::default() };
        let attempts = vec![
            Attempt::ok("alass", 1200),
            Attempt::failed("ffsubsync", &crash),
            Attempt::failed("alass", &timeout),
            Attempt::failed("alass", &shift),
        ];
        assert_eq!(
            format_attempts(&attempts),
            "alass ✓ +1200ms, ffsubsync ✗ error (could not decode audio), \
             alass ✗ timeout (Timeout: alass took longer than 300s), alass ✗ shift (42000ms)"
        );
        assert_eq!(failure_category(&attempts[1..3]), Category::FailedTimeout);
        assert_eq!(failure_category(&attempts[1..2]), Category::FailedError);
        let skipped = EngineResult { skipped: true, ..Default::default() };
        assert_eq!(failure_category(&[Attempt::failed("alass", &skipped)]), Category::FailedEnginesSkipped);
    }

    #[test]
    fn summary_block() {
        let mut s = RunSummary::new("r", false);
        s.scan = ScanStats { found: 10, need_sync: 3, already_synced: 7, parked: 0 };
        s.record(Category::Synced, "/m/a.srt", "");
        for i in 0..30 {
            s.record(Category::FailedError, &format!("/m/{i}.srt"), "alass ✗ error");
        }
        let text = s.format().join("\n");
        assert!(text.contains("Scan: 10 subtitle(s) found, 3 needed sync, 7 already synced"));
        assert!(text.contains("     1  synced (both engines agree)"));
        assert!(text.contains("-- failed: engine error (no strike) (30, first 25 shown):"));
        assert!(text.contains("   /m/0.srt — alass ✗ error"));
        assert!(!text.contains("/m/a.srt"));
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["counts"]["failed_error"], 30);
        assert_eq!(json["scan"]["alreadySynced"], 7);
    }
}
