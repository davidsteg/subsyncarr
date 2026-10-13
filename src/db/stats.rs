//! Statistics history: one row per subtitle decision and per engine
//! invocation, written by the processor and kept independently of run
//! retention, plus the aggregation behind `GET /api/stats/deep`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{QueryBuilder, Row, Sqlite};

use super::Db;
use crate::models::EngineResult;
use crate::quality::{GOOD_FROM, WEAK_BELOW};
use crate::stats::{classify, library_of, percentile};
use crate::summary::classify_failure;

/// Settings-table key set once old run history has been copied in.
const BACKFILLED_KEY: &str = "stats_backfilled";
/// Most points sent for the engine agreement scatter plot.
const SCATTER_MAX: usize = 1500;
const RUNS_MAX: i64 = 100;
const TITLES_MAX: usize = 25;
const WORST_PAIRS_MAX: usize = 25;
const ORPHANS_LISTED: usize = 100;
const ORPHANS_CHECKED: i64 = 1000;

/// Outcome category → the coarse class charts and breakdowns use.
const CLASS: &str = "CASE
    WHEN category IN ('synced', 'synced_single_engine', 'already_in_sync') THEN 'synced'
    WHEN category IN ('not_fitting_disagree', 'not_fitting_shift', 'not_fitting_unconfirmed', 'forced_kept')
      THEN 'not_fitting'
    WHEN category = 'deleted' THEN 'deleted'
    WHEN category = 'forced_parked' THEN 'parked'
    WHEN category = 'no_video' THEN 'no_video'
    ELSE 'failed' END";

/// Window filter shared by every history query: `?1` = from (ms), `?2` = include dry runs.
const WINDOW: &str = "ts >= ?1 AND (?2 OR dry_run = 0)";

/// Signed shift buckets (ms) for the per-engine offset histogram.
const SHIFT_EDGES: [i64; 10] = [-30_000, -10_000, -5_000, -2_000, -500, 500, 2_000, 5_000, 10_000, 30_000];
/// Absolute disagreement buckets (ms) between the two engines.
const DISAGREE_EDGES: [i64; 8] = [100, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

pub struct OutcomeRecord<'a> {
    pub run_id: &'a str,
    pub ts: i64,
    pub file_path: &'a str,
    pub category: &'a str,
    pub library: Option<&'a str>,
    pub sync_mode: Option<&'a str>,
    /// `audio`, `embedded`, `anchor` or `unknown`.
    pub reference: &'a str,
    /// The embedded-track pass didn't keep the subtitle; this is the audio retry.
    pub retried: bool,
    /// Up to two engines in chain order: (engine, result, shift).
    pub engines: &'a [(String, &'a str, Option<i64>)],
    pub quality_score: Option<i64>,
    pub strikes: Option<i64>,
    pub dry_run: bool,
    pub manual: bool,
}

pub struct EngineRunRecord<'a> {
    pub run_id: &'a str,
    pub ts: i64,
    pub engine: &'a str,
    pub reference: &'a str,
    /// `ok`, `shift`, `timeout`, `skipped`, `no_output` or `error`.
    pub result: &'a str,
    pub shift_ms: Option<i64>,
    pub duration_ms: i64,
    pub framerate_scaled: bool,
    pub dry_run: bool,
}

pub struct StatsQuery {
    /// 0 = everything kept.
    pub days: i64,
    pub include_dry: bool,
    /// Minutes east of UTC, so day buckets follow the viewer's midnight.
    pub tz_offset_min: i64,
    pub agreement_threshold_ms: i64,
    pub strike_threshold: i64,
    pub scan_roots: Vec<PathBuf>,
}

#[derive(Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClassCounts {
    total: i64,
    synced: i64,
    not_fitting: i64,
    failed: i64,
    deleted: i64,
    parked: i64,
    no_video: i64,
    avg_quality: Option<f64>,
    #[serde(skip)]
    q_sum: i64,
    #[serde(skip)]
    q_n: i64,
}

impl ClassCounts {
    fn add(&mut self, class: &str, n: i64, q_sum: i64, q_n: i64) {
        self.total += n;
        match class {
            "synced" => self.synced += n,
            "not_fitting" => self.not_fitting += n,
            "deleted" => self.deleted += n,
            "parked" => self.parked += n,
            "no_video" => self.no_video += n,
            _ => self.failed += n,
        }
        self.q_sum += q_sum;
        self.q_n += q_n;
        self.avg_quality = (self.q_n > 0).then(|| round1(self.q_sum as f64 / self.q_n as f64));
    }

    fn problems(&self) -> i64 {
        self.not_fitting + self.failed + self.deleted + self.parked
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn bucket_index(v: i64, edges: &[i64]) -> usize {
    edges.iter().position(|e| v < *e).unwrap_or(edges.len())
}

fn secs(ms: i64) -> String {
    let s = ms as f64 / 1000.0;
    if s.fract() == 0.0 {
        format!("{}", s as i64)
    } else {
        format!("{s}")
    }
}

/// `[{label, lo, hi, count}]`: `< -30 s`, `-30…-10 s`, `± 0.5 s`, …, `≥ 30 s`.
fn histogram(values: &[i64], edges: &[i64]) -> Vec<Value> {
    let mut counts = vec![0i64; edges.len() + 1];
    for v in values {
        counts[bucket_index(*v, edges)] += 1;
    }
    counts
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let lo = (i > 0).then(|| edges[i - 1]);
            let hi = edges.get(i).copied();
            let label = match (lo, hi) {
                (None, Some(h)) => format!("< {} s", secs(h)),
                (Some(l), None) => format!("≥ {} s", secs(l)),
                (Some(l), Some(h)) if l < 0 && h > 0 && l == -h => format!("± {} s", secs(h)),
                (Some(l), Some(h)) => format!("{}…{} s", secs(l), secs(h)),
                (None, None) => String::new(),
            };
            json!({ "label": label, "lo": lo, "hi": hi, "count": c })
        })
        .collect()
}

fn spread(sorted: &[i64]) -> Value {
    json!({
        "p10": percentile(sorted, 10.0),
        "p50": percentile(sorted, 50.0),
        "p90": percentile(sorted, 90.0),
        "p99": percentile(sorted, 99.0),
        "max": sorted.last(),
        "mean": (!sorted.is_empty()).then(|| sorted.iter().sum::<i64>() / sorted.len() as i64),
    })
}

/// An engine result stored in `file_results.engines` (1.x or 2.x shape),
/// reduced to (result, shift, duration, framerate scaled).
fn parse_engine_json(v: &Value) -> (&'static str, Option<i64>, i64, bool) {
    let r = EngineResult {
        success: v.get("success").and_then(Value::as_bool).unwrap_or(false),
        duration: v.get("duration").and_then(Value::as_i64).unwrap_or(0),
        message: v.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
        stderr: v.get("stderr").and_then(Value::as_str).map(str::to_string),
        skipped: v.get("skipped").and_then(Value::as_bool).unwrap_or(false),
        offset_ms: v.get("offsetMs").and_then(Value::as_i64),
        shift_too_large: v.get("shiftTooLarge").and_then(Value::as_bool).unwrap_or(false),
        original_shift_ms: v.get("originalShiftMs").and_then(Value::as_i64),
        framerate_scale: v.get("framerateScale").and_then(Value::as_f64),
        ..Default::default()
    };
    let result = if r.success && !r.skipped { "ok" } else { classify_failure(&r) };
    let shift = if result == "ok" { r.offset_ms } else { r.original_shift_ms };
    let scaled = r.framerate_scale.is_some_and(|f| (f - 1.0).abs() > 0.0005);
    (result, shift, r.duration, scaled)
}

/// Category for a `file_results` row from before the statistics history.
fn legacy_category(status: &str, video: Option<&str>, results: &[&str]) -> &'static str {
    let ok = results.iter().filter(|r| **r == "ok").count();
    match status {
        "completed" if ok >= 2 => "synced",
        "completed" => "synced_single_engine",
        "not_fitting" if ok >= 2 => "not_fitting_disagree",
        "not_fitting" => "not_fitting_shift",
        _ if results.is_empty() && video.is_none() => "no_video",
        _ if !results.is_empty() && results.iter().all(|r| *r == "skipped") => "failed_engines_skipped",
        _ if results.contains(&"timeout") => "failed_timeout",
        _ => "failed_error",
    }
}

impl Db {
    pub async fn record_outcome(&self, o: &OutcomeRecord<'_>) -> sqlx::Result<()> {
        self.insert_outcomes(&mut *self.pool().acquire().await?, std::slice::from_ref(o)).await
    }

    async fn insert_outcomes(&self, conn: &mut sqlx::SqliteConnection, rows: &[OutcomeRecord<'_>]) -> sqlx::Result<()> {
        for chunk in rows.chunks(500) {
            let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
                "INSERT INTO stat_outcomes (run_id, ts, file_path, category, media_kind, title, library, language,
                 forced, sync_mode, reference, retried, engine_a, result_a, shift_a_ms, engine_b, result_b, shift_b_ms,
                 quality_score, strikes, dry_run, manual) ",
            );
            qb.push_values(chunk, |mut b, o| {
                let m = classify(o.file_path);
                let a = o.engines.first();
                let e2 = o.engines.get(1);
                b.push_bind(o.run_id)
                    .push_bind(o.ts)
                    .push_bind(o.file_path)
                    .push_bind(o.category)
                    .push_bind(m.kind)
                    .push_bind(m.title)
                    .push_bind(o.library)
                    .push_bind(m.language)
                    .push_bind(m.forced)
                    .push_bind(o.sync_mode)
                    .push_bind(o.reference)
                    .push_bind(o.retried)
                    .push_bind(a.map(|e| e.0.clone()))
                    .push_bind(a.map(|e| e.1))
                    .push_bind(a.and_then(|e| e.2))
                    .push_bind(e2.map(|e| e.0.clone()))
                    .push_bind(e2.map(|e| e.1))
                    .push_bind(e2.and_then(|e| e.2))
                    .push_bind(o.quality_score)
                    .push_bind(o.strikes)
                    .push_bind(o.dry_run)
                    .push_bind(o.manual);
            });
            qb.build().execute(&mut *conn).await?;
        }
        Ok(())
    }

    pub async fn record_engine_run(&self, r: &EngineRunRecord<'_>) -> sqlx::Result<()> {
        self.insert_engine_runs(&mut *self.pool().acquire().await?, std::slice::from_ref(r)).await
    }

    async fn insert_engine_runs(
        &self,
        conn: &mut sqlx::SqliteConnection,
        rows: &[EngineRunRecord<'_>],
    ) -> sqlx::Result<()> {
        for chunk in rows.chunks(500) {
            let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
                "INSERT INTO stat_engine_runs (run_id, ts, engine, reference, result, shift_ms, duration_ms,
                 framerate_scaled, dry_run) ",
            );
            qb.push_values(chunk, |mut b, r| {
                b.push_bind(r.run_id)
                    .push_bind(r.ts)
                    .push_bind(r.engine)
                    .push_bind(r.reference)
                    .push_bind(r.result)
                    .push_bind(r.shift_ms)
                    .push_bind(r.duration_ms)
                    .push_bind(r.framerate_scaled)
                    .push_bind(r.dry_run);
            });
            qb.build().execute(&mut *conn).await?;
        }
        Ok(())
    }

    pub async fn delete_old_stats(&self, older_than_days: i64) -> sqlx::Result<u64> {
        let cutoff = crate::now_ms() - older_than_days * 86_400_000;
        let mut tx = self.pool().begin().await?;
        let a = sqlx::query("DELETE FROM stat_outcomes WHERE ts < ?").bind(cutoff).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM stat_engine_runs WHERE ts < ?").bind(cutoff).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(a.rows_affected())
    }

    /// One-time copy of the run history that predates the statistics tables
    /// (whatever run retention kept), so the page isn't empty after an
    /// upgrade. Deletions, parking and the sync reference weren't recorded
    /// back then; those rows say `unknown` where it matters.
    pub async fn backfill_stats(&self, scan_roots: &[PathBuf]) -> anyhow::Result<u64> {
        if self.all_settings().await?.contains_key(BACKFILLED_KEY) {
            return Ok(0);
        }
        let has_rows: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM stat_outcomes)").fetch_one(self.pool()).await?;
        let mut copied = 0u64;
        let mut last_id = 0i64;
        // Rows recorded live already: the history is running, never mix in old ones.
        if !has_rows {
            loop {
                let rows = sqlx::query(
                    "SELECT fr.id, fr.run_id, fr.file_path, fr.video_path, fr.status, fr.engines, fr.sync_mode,
                        fr.quality_score, fr.updated_at, COALESCE(r.dry_run, 0) AS dry_run
                 FROM file_results fr JOIN runs r ON r.id = fr.run_id
                 WHERE fr.id > ? AND fr.status IN ('completed', 'not_fitting', 'error') AND r.status != 'running'
                 ORDER BY fr.id LIMIT 2000",
                )
                .bind(last_id)
                .fetch_all(self.pool())
                .await?;
                let Some(last) = rows.last() else { break };
                last_id = last.get("id");

                struct Legacy {
                    run_id: String,
                    path: String,
                    ts: i64,
                    category: &'static str,
                    library: Option<String>,
                    mode: Option<String>,
                    reference: &'static str,
                    engines: Vec<(String, &'static str, Option<i64>)>,
                    runs: Vec<(String, &'static str, Option<i64>, i64, bool)>,
                    quality: Option<i64>,
                    dry: bool,
                }
                let parsed: Vec<Legacy> = rows
                    .iter()
                    .map(|r| {
                        let path: String = r.get("file_path");
                        let engines: Value = r
                            .get::<Option<String>, _>("engines")
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or(Value::Null);
                        let runs: Vec<(String, &'static str, Option<i64>, i64, bool)> = engines
                            .as_object()
                            .map(|m| {
                                m.iter()
                                    .map(|(k, v)| {
                                        let (res, shift, dur, scaled) = parse_engine_json(v);
                                        (k.clone(), res, shift, dur, scaled)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let results: Vec<&str> = runs.iter().map(|r| r.1).collect();
                        let video: Option<String> = r.get("video_path");
                        let mode: Option<String> = r.get("sync_mode");
                        Legacy {
                            run_id: r.get("run_id"),
                            ts: r.get("updated_at"),
                            category: legacy_category(&r.get::<String, _>("status"), video.as_deref(), &results),
                            library: library_of(&path, scan_roots),
                            reference: if mode.as_deref() == Some("follower") { "anchor" } else { "unknown" },
                            mode,
                            engines: runs.iter().take(2).map(|r| (r.0.clone(), r.1, r.2)).collect(),
                            runs,
                            quality: r.get("quality_score"),
                            dry: r.get::<i64, _>("dry_run") != 0,
                            path,
                        }
                    })
                    .collect();
                let outcomes: Vec<OutcomeRecord> = parsed
                    .iter()
                    .map(|l| OutcomeRecord {
                        run_id: &l.run_id,
                        ts: l.ts,
                        file_path: &l.path,
                        category: l.category,
                        library: l.library.as_deref(),
                        sync_mode: l.mode.as_deref(),
                        reference: l.reference,
                        retried: false,
                        engines: &l.engines,
                        quality_score: l.quality,
                        strikes: None,
                        dry_run: l.dry,
                        manual: false,
                    })
                    .collect();
                let engine_runs: Vec<EngineRunRecord> = parsed
                    .iter()
                    .flat_map(|l| {
                        l.runs.iter().map(move |(engine, result, shift, dur, scaled)| EngineRunRecord {
                            run_id: &l.run_id,
                            ts: l.ts,
                            engine,
                            reference: l.reference,
                            result,
                            shift_ms: *shift,
                            duration_ms: *dur,
                            framerate_scaled: *scaled,
                            dry_run: l.dry,
                        })
                    })
                    .collect();
                let mut tx = self.pool().begin().await?;
                self.insert_outcomes(&mut tx, &outcomes).await?;
                self.insert_engine_runs(&mut tx, &engine_runs).await?;
                tx.commit().await?;
                copied += outcomes.len() as u64;
            }
        }
        self.set_settings(&[(BACKFILLED_KEY.into(), crate::now_ms().to_string())]).await?;
        Ok(copied)
    }

    /// Outcome counts per value of `dim` (an SQL expression over `stat_outcomes`).
    async fn class_counts_by(&self, dim: &str, from: i64, dry: bool) -> sqlx::Result<BTreeMap<String, ClassCounts>> {
        let rows = sqlx::query(&format!(
            "SELECT CAST({dim} AS TEXT) AS k, {CLASS} AS c, COUNT(*) AS n,
                    COALESCE(SUM(quality_score), 0) AS qs, COUNT(quality_score) AS qn
             FROM stat_outcomes WHERE {WINDOW} GROUP BY k, c"
        ))
        .bind(from)
        .bind(dry)
        .fetch_all(self.pool())
        .await?;
        let mut out: BTreeMap<String, ClassCounts> = BTreeMap::new();
        for r in rows {
            let k: Option<String> = r.get("k");
            out.entry(k.unwrap_or_default()).or_default().add(
                &r.get::<String, _>("c"),
                r.get("n"),
                r.get("qs"),
                r.get("qn"),
            );
        }
        Ok(out)
    }

    pub async fn deep_stats(&self, q: &StatsQuery) -> anyhow::Result<Value> {
        let now = crate::now_ms();
        let from = if q.days > 0 { now - q.days * 86_400_000 } else { 0 };
        let dry = q.include_dry;
        let day = 86_400_000i64;
        let bucket_ms = if q.days == 0 || q.days > 90 { 7 * day } else { day };
        let tz_ms = q.tz_offset_min * 60_000;

        // ---- totals per category
        let cats =
            sqlx::query(&format!("SELECT category, COUNT(*) AS n FROM stat_outcomes WHERE {WINDOW} GROUP BY category"))
                .bind(from)
                .bind(dry)
                .fetch_all(self.pool())
                .await?;
        let categories: BTreeMap<String, i64> = cats.iter().map(|r| (r.get("category"), r.get("n"))).collect();
        let (files, first_ts): (i64, Option<i64>) =
            sqlx::query_as(&format!("SELECT COUNT(DISTINCT file_path), MIN(ts) FROM stat_outcomes WHERE {WINDOW}"))
                .bind(from)
                .bind(dry)
                .fetch_one(self.pool())
                .await?;
        let overall = self.class_counts_by("'all'", from, dry).await?.remove("all").unwrap_or_default();

        // ---- timeline: classes per bucket
        let timeline_counts =
            self.class_counts_by(&format!("((ts + {tz_ms}) / {bucket_ms}) * {bucket_ms} - {tz_ms}"), from, dry).await?;

        // ---- engine agreement: every decision where both engines proposed a shift
        let pair_rows = sqlx::query(&format!(
            "SELECT ts, file_path, category, engine_a, engine_b, shift_a_ms, shift_b_ms FROM stat_outcomes
             WHERE {WINDOW} AND shift_a_ms IS NOT NULL AND shift_b_ms IS NOT NULL ORDER BY ts"
        ))
        .bind(from)
        .bind(dry)
        .fetch_all(self.pool())
        .await?;
        struct Pair {
            ts: i64,
            path: String,
            category: String,
            a: i64,
            b: i64,
        }
        let mut by_pair: BTreeMap<(String, String), Vec<Pair>> = BTreeMap::new();
        for r in &pair_rows {
            let (mut ea, mut eb): (String, String) = (r.get("engine_a"), r.get("engine_b"));
            let (mut a, mut b): (i64, i64) = (r.get("shift_a_ms"), r.get("shift_b_ms"));
            // Same axis for the same engine, whichever was the default.
            if ea > eb {
                std::mem::swap(&mut ea, &mut eb);
                std::mem::swap(&mut a, &mut b);
            }
            let p = Pair { ts: r.get("ts"), path: r.get("file_path"), category: r.get("category"), a, b };
            by_pair.entry((ea, eb)).or_default().push(p);
        }
        // One block per engine pair (the chain may have changed in the window),
        // most decisions first.
        let mut agreement: Vec<(usize, Value)> = by_pair
            .iter()
            .map(|((ea, eb), pairs)| {
                let mut diffs: Vec<i64> = pairs.iter().map(|p| (p.a - p.b).abs()).collect();
                let mut signed: Vec<i64> = pairs.iter().map(|p| p.a - p.b).collect();
                let hist = histogram(&diffs, &DISAGREE_EDGES);
                diffs.sort_unstable();
                signed.sort_unstable();
                let within = diffs.iter().filter(|d| **d <= q.agreement_threshold_ms).count();
                // One engine moves the subtitle a lot while the other leaves it in place.
                let a_only = pairs.iter().filter(|p| p.a.abs() >= 2_000 && p.b.abs() < 500).count();
                let b_only = pairs.iter().filter(|p| p.b.abs() >= 2_000 && p.a.abs() < 500).count();
                let stride = pairs.len().div_ceil(SCATTER_MAX).max(1);
                let scatter: Vec<Value> =
                    pairs.iter().step_by(stride).map(|p| json!([p.a, p.b, p.category.starts_with("synced")])).collect();
                let mut by_diff: Vec<&Pair> = pairs.iter().collect();
                by_diff.sort_by_key(|p| std::cmp::Reverse(((p.a - p.b).abs(), p.ts)));
                let mut seen = std::collections::HashSet::new();
                let worst: Vec<Value> = by_diff
                    .into_iter()
                    .filter(|p| seen.insert(p.path.as_str()))
                    .take(WORST_PAIRS_MAX)
                    .map(|p| json!({ "filePath": p.path, "ts": p.ts, "category": p.category, "a": p.a, "b": p.b }))
                    .collect();
                let block = json!({
                    "engines": [ea, eb],
                    "pairs": pairs.len(),
                    "withinThreshold": within,
                    "absDiffMs": spread(&diffs),
                    "biasMs": percentile(&signed, 50.0),
                    "histogram": hist,
                    "onlyFirstMoves": a_only,
                    "onlySecondMoves": b_only,
                    "scatter": scatter,
                    "worst": worst,
                });
                (pairs.len(), block)
            })
            .collect();
        agreement.sort_by_key(|(n, _)| std::cmp::Reverse(*n));
        let agreement: Vec<Value> = agreement.into_iter().map(|(_, v)| v).collect();
        let mut bucket_diffs: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
        for p in by_pair.values().flatten() {
            let b = ((p.ts + tz_ms).div_euclid(bucket_ms)) * bucket_ms - tz_ms;
            bucket_diffs.entry(b).or_default().push((p.a - p.b).abs());
        }

        let timeline: Vec<Value> = {
            let mut keys: Vec<i64> = timeline_counts.keys().filter_map(|k| k.parse().ok()).collect();
            keys.extend(bucket_diffs.keys());
            keys.sort_unstable();
            keys.dedup();
            keys.into_iter()
                .map(|t| {
                    let c = timeline_counts.get(&t.to_string()).cloned().unwrap_or_default();
                    let median = bucket_diffs.get_mut(&t).and_then(|v| {
                        v.sort_unstable();
                        percentile(v, 50.0)
                    });
                    let mut v = serde_json::to_value(c).unwrap_or_default();
                    v["t"] = json!(t);
                    v["medianDisagreementMs"] = json!(median);
                    v
                })
                .collect()
        };

        // ---- engines
        let er = sqlx::query(&format!(
            "SELECT engine, reference, result, COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS dur
             FROM stat_engine_runs WHERE {WINDOW} GROUP BY engine, reference, result"
        ))
        .bind(from)
        .bind(dry)
        .fetch_all(self.pool())
        .await?;
        let samples = sqlx::query(&format!(
            "SELECT engine, result, shift_ms, duration_ms, framerate_scaled FROM stat_engine_runs
             WHERE {WINDOW} AND result != 'skipped'"
        ))
        .bind(from)
        .bind(dry)
        .fetch_all(self.pool())
        .await?;
        #[derive(Default)]
        struct Eng {
            results: BTreeMap<String, i64>,
            by_reference: BTreeMap<String, BTreeMap<String, i64>>,
            total_ms: i64,
            durations: Vec<i64>,
            shifts: Vec<i64>,
            ok_shifts: Vec<i64>,
            framerate_scaled: i64,
        }
        let mut engines: BTreeMap<String, Eng> = BTreeMap::new();
        for r in &er {
            let e = engines.entry(r.get("engine")).or_default();
            let (res, n): (String, i64) = (r.get("result"), r.get("n"));
            *e.results.entry(res.clone()).or_default() += n;
            *e.by_reference.entry(r.get("reference")).or_default().entry(res).or_default() += n;
            e.total_ms += r.get::<i64, _>("dur");
        }
        for r in &samples {
            let e = engines.entry(r.get("engine")).or_default();
            e.durations.push(r.get("duration_ms"));
            if let Some(s) = r.get::<Option<i64>, _>("shift_ms") {
                e.shifts.push(s);
                if r.get::<String, _>("result") == "ok" {
                    e.ok_shifts.push(s);
                }
            }
            e.framerate_scaled += r.get::<i64, _>("framerate_scaled");
        }
        let engines_json: Vec<Value> = engines
            .into_iter()
            .map(|(name, mut e)| {
                e.durations.sort_unstable();
                let hist = histogram(&e.shifts, &SHIFT_EDGES);
                e.shifts.sort_unstable();
                e.ok_shifts.sort_unstable();
                let mut abs: Vec<i64> = e.ok_shifts.iter().map(|s| s.abs()).collect();
                abs.sort_unstable();
                let runs: i64 = e.results.values().sum();
                json!({
                    "engine": name,
                    "runs": runs,
                    "results": e.results,
                    "byReference": e.by_reference,
                    "totalMs": e.total_ms,
                    "durationMs": spread(&e.durations),
                    "shiftMs": spread(&e.ok_shifts),
                    "absShiftMs": spread(&abs),
                    "shiftHistogram": hist,
                    "framerateScaled": e.framerate_scaled,
                })
            })
            .collect();

        // ---- runs
        let run_rows = sqlx::query(&format!(
            "SELECT s.*, r.start_time, r.end_time, r.status, e.engine_ms FROM (
                SELECT run_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS decisions,
                       SUM(({CLASS}) = 'synced') AS synced, SUM(({CLASS}) = 'not_fitting') AS not_fitting,
                       SUM(({CLASS}) = 'failed') AS failed, SUM(({CLASS}) = 'deleted') AS deleted,
                       SUM(({CLASS}) = 'parked') AS parked, SUM(({CLASS}) = 'no_video') AS no_video,
                       AVG(quality_score) AS avg_quality, MAX(dry_run) AS dry_run, MAX(manual) AS manual
                FROM stat_outcomes WHERE {WINDOW} GROUP BY run_id
             ) s
             LEFT JOIN runs r ON r.id = s.run_id
             LEFT JOIN (SELECT run_id, SUM(duration_ms) AS engine_ms FROM stat_engine_runs WHERE ts >= ?1 GROUP BY run_id) e
               ON e.run_id = s.run_id
             ORDER BY s.first_ts DESC LIMIT {RUNS_MAX}"
        ))
        .bind(from)
        .bind(dry)
        .fetch_all(self.pool())
        .await?;
        let mut run_ms_total = 0i64;
        let mut run_decisions_total = 0i64;
        let runs: Vec<Value> = run_rows
            .iter()
            .map(|r| {
                let first: i64 = r.get("first_ts");
                let last: i64 = r.get("last_ts");
                let start: Option<i64> = r.get("start_time");
                let end: Option<i64> = r.get("end_time");
                let duration = match (start, end) {
                    (Some(s), Some(e)) if e > s => e - s,
                    _ => last - first,
                };
                let decisions: i64 = r.get("decisions");
                if duration >= 60_000 {
                    run_ms_total += duration;
                    run_decisions_total += decisions;
                }
                json!({
                    "runId": r.get::<String, _>("run_id"),
                    "start": start.unwrap_or(first),
                    "end": end.unwrap_or(last),
                    "status": r.get::<Option<String>, _>("status"),
                    "durationMs": duration,
                    "decisions": decisions,
                    "synced": r.get::<i64, _>("synced"),
                    "notFitting": r.get::<i64, _>("not_fitting"),
                    "failed": r.get::<i64, _>("failed"),
                    "deleted": r.get::<i64, _>("deleted"),
                    "parked": r.get::<i64, _>("parked"),
                    "noVideo": r.get::<i64, _>("no_video"),
                    "avgQuality": r.get::<Option<f64>, _>("avg_quality").map(round1),
                    "engineMs": r.get::<Option<i64>, _>("engine_ms").unwrap_or(0),
                    "filesPerHour": (duration >= 60_000).then(|| round1(decisions as f64 * 3_600_000.0 / duration as f64)),
                    "dryRun": r.get::<i64, _>("dry_run") != 0,
                    "manual": r.get::<i64, _>("manual") != 0,
                })
            })
            .collect();

        // ---- breakdowns
        let mut titles: Vec<(String, ClassCounts)> = self
            .class_counts_by("title", from, dry)
            .await?
            .into_iter()
            .filter(|(k, c)| !k.is_empty() && c.problems() > 0)
            .collect();
        titles.sort_by(|a, b| b.1.problems().cmp(&a.1.problems()).then(b.1.total.cmp(&a.1.total)));
        titles.truncate(TITLES_MAX);
        let rows_of = |m: BTreeMap<String, ClassCounts>| -> Vec<Value> {
            let mut v: Vec<(String, ClassCounts)> = m.into_iter().collect();
            v.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.0.cmp(&b.0)));
            v.into_iter()
                .map(|(k, c)| {
                    let mut j = serde_json::to_value(c).unwrap_or_default();
                    j["key"] = json!(k);
                    j
                })
                .collect()
        };
        let breakdowns = json!({
            "language": rows_of(self.class_counts_by("COALESCE(language, 'Unknown')", from, dry).await?),
            "forced": rows_of(self.class_counts_by("CASE WHEN forced = 1 THEN 'forced' ELSE 'regular' END", from, dry).await?),
            "kind": rows_of(self.class_counts_by("media_kind", from, dry).await?),
            "reference": rows_of(self.class_counts_by("reference", from, dry).await?),
            "mode": rows_of(self.class_counts_by("COALESCE(sync_mode, 'none')", from, dry).await?),
            "library": rows_of(self.class_counts_by("COALESCE(library, 'Other')", from, dry).await?),
            "titles": rows_of(titles.into_iter().collect()),
        });

        // ---- quality now (sync_quality is the current state, not history)
        let qrows = sqlx::query(
            "SELECT MIN(score / 10, 9) AS b, COUNT(*) AS n FROM sync_quality WHERE score IS NOT NULL GROUP BY b",
        )
        .fetch_all(self.pool())
        .await?;
        let mut qhist = [0i64; 10];
        for r in &qrows {
            let b: i64 = r.get("b");
            qhist[b.clamp(0, 9) as usize] += r.get::<i64, _>("n");
        }
        let (unscored, needs_review, reviewed, avg_now): (i64, i64, i64, Option<f64>) = sqlx::query_as(
            "SELECT COALESCE(SUM(score IS NULL), 0), COALESCE(SUM(score < ?1 AND reviewed = 0), 0),
                    COALESCE(SUM(score < ?1 AND reviewed = 1), 0), AVG(score)
             FROM sync_quality",
        )
        .bind(WEAK_BELOW)
        .fetch_one(self.pool())
        .await?;
        let level = |lo: usize, hi: usize| qhist[lo..hi].iter().sum::<i64>();
        let (weak_b, good_b) = ((WEAK_BELOW / 10) as usize, (GOOD_FROM / 10) as usize);
        let quality = json!({
            "histogram": qhist.iter().enumerate().map(|(i, n)| json!({
                "label": if i == 9 { "90–100".to_string() } else { format!("{}–{}", i * 10, i * 10 + 9) },
                "lo": i * 10,
                "count": n,
            })).collect::<Vec<_>>(),
            "levels": { "weak": level(0, weak_b), "fair": level(weak_b, good_b), "good": level(good_b, 10) },
            "unscored": unscored,
            "needsReview": needs_review,
            "reviewed": reviewed,
            "average": avg_now.map(round1),
            "weakBelow": WEAK_BELOW,
            "goodFrom": GOOD_FROM,
        });

        // ---- strikes and blocked files now
        let srows = sqlx::query(
            "SELECT consecutive_strikes AS s, COUNT(*) AS n FROM not_fitting_tracking
             WHERE consecutive_strikes > 0 GROUP BY s ORDER BY s",
        )
        .fetch_all(self.pool())
        .await?;
        let (parked, skipped_files): (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM parked_files),
                    (SELECT COUNT(DISTINCT file_path) FROM engine_failure_tracking WHERE is_skipped = 1)",
        )
        .fetch_one(self.pool())
        .await?;
        let skipped_by_engine = self.failure_stats().await?["skippedByEngine"].clone();
        let strikes = json!({
            "threshold": q.strike_threshold,
            "distribution": srows.iter().map(|r| json!({ "strikes": r.get::<i64, _>("s"), "count": r.get::<i64, _>("n") })).collect::<Vec<_>>(),
            "parked": parked,
            "skippedEngineFiles": skipped_files,
            "skippedByEngine": skipped_by_engine,
        });

        // ---- orphans: subtitles whose latest decision was "no matching video"
        let orows = sqlx::query(&format!(
            "SELECT file_path, ts FROM (
                SELECT file_path, category, MAX(ts) AS ts FROM stat_outcomes WHERE dry_run = 0 GROUP BY file_path
             ) WHERE category = 'no_video' ORDER BY ts DESC LIMIT {ORPHANS_CHECKED}"
        ))
        .fetch_all(self.pool())
        .await?;
        let candidates: Vec<(String, i64)> = orows.iter().map(|r| (r.get("file_path"), r.get("ts"))).collect();
        let checked = candidates.len() as i64;
        // A subtitle that has since been removed is no longer an orphan.
        let still_there = tokio::task::spawn_blocking(move || {
            candidates.into_iter().filter(|(p, _)| std::path::Path::new(p).is_file()).collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let orphans = json!({
            "count": still_there.len(),
            "truncated": checked >= ORPHANS_CHECKED,
            "items": still_there.iter().take(ORPHANS_LISTED).map(|(p, ts)| json!({ "filePath": p, "lastSeen": ts })).collect::<Vec<_>>(),
        });

        let decisions = overall.total;
        let kept_base = decisions - overall.no_video;
        Ok(json!({
            "window": {
                "days": q.days,
                "from": from,
                "to": now,
                "bucketMs": bucket_ms,
                "firstRecord": first_ts,
                "includeDryRuns": dry,
            },
            "totals": {
                "decisions": decisions,
                "files": files,
                "synced": overall.synced,
                "notFitting": overall.not_fitting,
                "failed": overall.failed,
                "deleted": overall.deleted,
                "parked": overall.parked,
                "noVideo": overall.no_video,
                "keepRate": (kept_base > 0).then(|| round1(overall.synced as f64 * 100.0 / kept_base as f64)),
                "avgQuality": overall.avg_quality,
                "categories": categories,
            },
            "throughput": {
                "filesPerHour": (run_ms_total > 0).then(|| round1(run_decisions_total as f64 * 3_600_000.0 / run_ms_total as f64)),
                "runMs": run_ms_total,
            },
            "timeline": timeline,
            "runs": runs,
            "engines": engines_json,
            "agreement": {
                "thresholdMs": q.agreement_threshold_ms,
                "pairs": agreement,
            },
            "quality": quality,
            "strikes": strikes,
            "breakdowns": breakdowns,
            "orphans": orphans,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_labels_and_counts() {
        let h = histogram(&[-40_000, -100, 0, 499, 500, 25_000, 31_000], &SHIFT_EDGES);
        assert_eq!(h.len(), 11);
        assert_eq!(h[0]["label"], "< -30 s");
        assert_eq!(h[0]["count"], 1);
        assert_eq!(h[5]["label"], "± 0.5 s");
        assert_eq!(h[5]["count"], 3);
        assert_eq!(h[6]["label"], "0.5…2 s");
        assert_eq!(h[6]["count"], 1);
        assert_eq!(h[9]["count"], 1);
        assert_eq!(h[10]["label"], "≥ 30 s");
        let d = histogram(&[50, 150, 40_000], &DISAGREE_EDGES);
        assert_eq!(d[0]["label"], "< 0.1 s");
        assert_eq!(d[1]["label"], "0.1…0.5 s");
        assert_eq!(d[8]["count"], 1);
    }

    #[test]
    fn legacy_rows_map_to_categories() {
        assert_eq!(legacy_category("completed", Some("v"), &["ok", "ok"]), "synced");
        assert_eq!(legacy_category("completed", Some("v"), &["ok", "error"]), "synced_single_engine");
        assert_eq!(legacy_category("not_fitting", Some("v"), &["ok", "ok"]), "not_fitting_disagree");
        assert_eq!(legacy_category("not_fitting", Some("v"), &["shift", "ok"]), "not_fitting_shift");
        assert_eq!(legacy_category("error", None, &[]), "no_video");
        assert_eq!(legacy_category("error", Some("v"), &["skipped", "skipped"]), "failed_engines_skipped");
        assert_eq!(legacy_category("error", Some("v"), &["timeout", "error"]), "failed_timeout");
        assert_eq!(legacy_category("error", Some("v"), &["error"]), "failed_error");
    }

    #[tokio::test]
    async fn backfill_copies_finished_runs_once() {
        use crate::db::FileUpdate;
        use crate::models::FileStatus;
        let db = Db::open_memory().await.unwrap();
        db.create_run("r1", false).await.unwrap();
        let files = ["/media/TV/Show/Season 01/Show.S01E01.en.srt".to_string(), "/media/Loose/x.srt".to_string()];
        db.insert_pending_files("r1", &files).await.unwrap();
        let ok = json!({"success": true, "duration": 800, "message": "", "offsetMs": 21000});
        let zero = json!({"success": true, "duration": 3000, "message": "", "offsetMs": 0});
        db.set_file_engine_result("r1", &files[0], "alass", &ok).await.unwrap();
        db.set_file_engine_result("r1", &files[0], "ffsubsync", &zero).await.unwrap();
        let done = |s| FileUpdate { status: Some(s), video_path: Some(Some("/v.mkv")), ..Default::default() };
        db.update_file("r1", &files[0], done(FileStatus::NotFitting)).await.unwrap();
        let err = FileUpdate { status: Some(FileStatus::Error), ..Default::default() };
        db.update_file("r1", &files[1], err).await.unwrap();
        db.finish_run("r1", "completed").await.unwrap();

        assert_eq!(db.backfill_stats(&[PathBuf::from("/media/TV")]).await.unwrap(), 2);
        assert_eq!(db.backfill_stats(&[]).await.unwrap(), 0, "runs once");
        let q = StatsQuery {
            days: 0,
            include_dry: false,
            tz_offset_min: 0,
            agreement_threshold_ms: 5000,
            strike_threshold: 3,
            scan_roots: vec![],
        };
        let v = db.deep_stats(&q).await.unwrap();
        assert_eq!(v["totals"]["notFitting"], 1, "{v}");
        assert_eq!(v["totals"]["noVideo"], 1);
        let block = &v["agreement"]["pairs"][0];
        assert_eq!((block["engines"][0].as_str(), block["worst"][0]["a"].as_i64()), (Some("alass"), Some(21000)));
        assert_eq!(block["onlyFirstMoves"], 1);
        assert_eq!(v["breakdowns"]["kind"][0]["key"], "episode");
        assert_eq!(v["breakdowns"]["titles"][0]["key"], "Show");
        assert_eq!(v["breakdowns"]["library"][0]["key"], "/media/TV");
        let alass = v["engines"].as_array().unwrap().iter().find(|e| e["engine"] == "alass").unwrap().clone();
        assert_eq!(alass["durationMs"]["p50"], 800);
        assert_eq!(alass["byReference"]["unknown"]["ok"], 1);
    }

    #[test]
    fn engine_json_from_either_version() {
        let ok = json!({"success": true, "duration": 1200, "message": "", "offsetMs": 15300});
        assert_eq!(parse_engine_json(&ok), ("ok", Some(15300), 1200, false));
        let shift = json!({"success": false, "duration": 900, "message": "Shift too large", "shiftTooLarge": true, "originalShiftMs": 42000});
        assert_eq!(parse_engine_json(&shift), ("shift", Some(42000), 900, false));
        let timeout = json!({"success": false, "message": "Timeout: alass took longer than 600s"});
        assert_eq!(parse_engine_json(&timeout).0, "timeout");
        let scaled = json!({"success": true, "duration": 5, "message": "", "offsetMs": 0, "framerateScale": 1.04});
        assert!(parse_engine_json(&scaled).3);
    }
}
