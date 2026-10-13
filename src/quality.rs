//! Sync confidence score (0–100) for a kept sync. Pure — no I/O — so the
//! weighting stays readable and tested in one place.
//!
//! Starts at 100 and subtracts a penalty per piece of doubt:
//! - engine disagreement, scaled against the agreement threshold
//! - only one engine produced output (nothing corroborates it)
//! - another engine rejected its result as a too-large shift
//! - split points: jumps between consecutive cue offsets, i.e. the engine cut
//!   the subtitle into independently shifted blocks
//! - few cues to lock onto (forced / sparse subs)
//! - a shift close to `MAX_SUBTITLE_SHIFT_MS`
//! - a framerate correction (ffsubsync stretched the timeline)
//!
//! Below `WEAK_BELOW` a sync is flagged for review.

use serde::{Deserialize, Serialize};

pub const WEAK_BELOW: i64 = 50;
pub const GOOD_FROM: i64 = 80;

/// Disagreement this small counts as exact agreement.
const AGREEMENT_NOISE_MS: i64 = 100;
const DISAGREEMENT_MAX_PENALTY: f64 = 35.0;
const SINGLE_ENGINE_PENALTY: i64 = 30;
const MISMATCH_PENALTY: i64 = 15;
/// A jump in cue offset larger than this between neighbouring cues is a split.
const SPLIT_JUMP_MS: i64 = 1000;
const SPLIT_PENALTY_EACH: i64 = 5;
const SPLIT_MAX_PENALTY: i64 = 25;
const SPARSE_CUES: usize = 20;
const SPARSE_PENALTY: i64 = 10;
const NEAR_LIMIT_PENALTY: i64 = 10;
const FRAMERATE_PENALTY: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Good,
    Fair,
    Weak,
}

impl Level {
    pub fn of(score: i64) -> Self {
        if score >= GOOD_FROM {
            Level::Good
        } else if score >= WEAK_BELOW {
            Level::Fair
        } else {
            Level::Weak
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Good => "good",
            Level::Fair => "fair",
            Level::Weak => "weak",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Factor {
    pub label: String,
    pub penalty: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub score: i64,
    pub level: Level,
    /// Engines that produced an alignment.
    pub engines_aligned: usize,
    pub disagreement_ms: Option<i64>,
    /// Kept shift (median over cues).
    pub shift_ms: i64,
    /// p90 − p10 of per-cue offsets.
    pub spread_ms: i64,
    pub split_points: usize,
    pub cues: usize,
    pub factors: Vec<Factor>,
}

pub struct Input<'a> {
    /// (engine, median shift) per engine that produced output, kept one first.
    pub alignments: &'a [(String, i64)],
    pub agreement_threshold_ms: i64,
    pub mismatch_reports: usize,
    /// Per-cue offsets of the kept output against the original.
    pub cue_offsets: &'a [i64],
    pub cues: usize,
    pub max_shift_ms: i64,
    pub framerate_scaled: bool,
}

fn percentile(sorted: &[i64], p: f64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[i.min(sorted.len() - 1)]
}

pub fn score(i: &Input) -> Quality {
    let mut factors = Vec::new();
    let mut add = |label: String, penalty: i64| {
        if penalty > 0 {
            factors.push(Factor { label, penalty });
        }
    };

    let disagreement = match i.alignments {
        [a, b, ..] => Some((a.1 - b.1).abs()),
        _ => None,
    };
    match (i.alignments, disagreement) {
        ([a, b, ..], Some(d)) if d > AGREEMENT_NOISE_MS => {
            let ratio = d as f64 / i.agreement_threshold_ms.max(1) as f64;
            let penalty = (DISAGREEMENT_MAX_PENALTY * ratio).round().min(DISAGREEMENT_MAX_PENALTY) as i64;
            add(format!("{} and {} differ by {d} ms", a.0, b.0), penalty);
        }
        ([only], _) => add(format!("Only {} produced output", only.0), SINGLE_ENGINE_PENALTY),
        _ => {}
    }
    if i.mismatch_reports > 0 {
        add("An engine rejected a too-large shift".into(), MISMATCH_PENALTY);
    }

    let split_points = i.cue_offsets.windows(2).filter(|w| (w[1] - w[0]).abs() > SPLIT_JUMP_MS).count();
    if split_points > 1 {
        let penalty = (SPLIT_PENALTY_EACH * (split_points as i64 - 1)).min(SPLIT_MAX_PENALTY);
        add(format!("Split into {} separately shifted blocks", split_points + 1), penalty);
    }

    if i.cues < SPARSE_CUES {
        add(format!("Only {} cues to align", i.cues), SPARSE_PENALTY);
    }

    let shift = i.alignments.first().map_or(0, |a| a.1);
    if i.max_shift_ms > 0 && shift.abs() * 2 > i.max_shift_ms {
        add(format!("Shift of {shift} ms is close to the {} ms limit", i.max_shift_ms), NEAR_LIMIT_PENALTY);
    }
    if i.framerate_scaled {
        add("Framerate was corrected".into(), FRAMERATE_PENALTY);
    }

    let mut sorted = i.cue_offsets.to_vec();
    sorted.sort_unstable();
    let spread_ms = percentile(&sorted, 0.9) - percentile(&sorted, 0.1);

    let score = (100 - factors.iter().map(|f| f.penalty).sum::<i64>()).clamp(0, 100);
    Quality {
        score,
        level: Level::of(score),
        engines_aligned: i.alignments.len(),
        disagreement_ms: disagreement,
        shift_ms: shift,
        spread_ms,
        split_points,
        cues: i.cues,
        factors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn al(v: &[(&str, i64)]) -> Vec<(String, i64)> {
        v.iter().map(|(e, s)| (e.to_string(), *s)).collect()
    }

    fn input<'a>(alignments: &'a [(String, i64)], offsets: &'a [i64]) -> Input<'a> {
        Input {
            alignments,
            agreement_threshold_ms: 5000,
            mismatch_reports: 0,
            cue_offsets: offsets,
            cues: 500,
            max_shift_ms: 60_000,
            framerate_scaled: false,
        }
    }

    #[test]
    fn clean_agreement_is_perfect() {
        let a = al(&[("alass", 1500), ("ffsubsync", 1520)]);
        let q = score(&input(&a, &[1500; 50]));
        assert_eq!(q.score, 100);
        assert_eq!(q.level, Level::Good);
        assert_eq!(q.disagreement_ms, Some(20));
        assert!(q.factors.is_empty());
    }

    #[test]
    fn disagreement_scales_with_threshold() {
        let a = al(&[("alass", 0), ("ffsubsync", 2500)]);
        let q = score(&input(&a, &[0; 50]));
        assert_eq!(q.score, 82); // half the threshold → half of 35 (rounded)
        let a = al(&[("alass", 0), ("ffsubsync", 5000)]);
        assert_eq!(score(&input(&a, &[0; 50])).score, 65);
    }

    #[test]
    fn single_engine_is_fair_not_good() {
        let a = al(&[("alass", 300)]);
        let q = score(&input(&a, &[300; 50]));
        assert_eq!(q.score, 70);
        assert_eq!(q.level, Level::Fair);
    }

    #[test]
    fn stacked_doubts_are_weak() {
        let a = al(&[("alass", 40_000)]);
        let mut offsets = vec![40_000; 10];
        offsets.extend([10_000; 5]);
        offsets.extend([40_000; 4]);
        let mut i = input(&a, &offsets);
        i.cues = 19;
        i.mismatch_reports = 1;
        let q = score(&i);
        // single 30 + mismatch 15 + sparse 10 + near limit 10 + 2 splits 5
        assert_eq!(q.score, 30);
        assert_eq!(q.level, Level::Weak);
        assert_eq!(q.split_points, 2);
        assert_eq!(q.spread_ms, 30_000);
    }

    #[test]
    fn one_split_is_free_and_penalty_caps() {
        let a = al(&[("alass", 0), ("ffsubsync", 0)]);
        assert_eq!(score(&input(&a, &[0, 0, 5000, 5000])).score, 100);
        let zigzag: Vec<i64> = (0..40).map(|i| if i % 2 == 0 { 0 } else { 5000 }).collect();
        assert_eq!(score(&input(&a, &zigzag)).score, 75);
    }

    #[test]
    fn levels() {
        assert_eq!(Level::of(80), Level::Good);
        assert_eq!(Level::of(79), Level::Fair);
        assert_eq!(Level::of(50), Level::Fair);
        assert_eq!(Level::of(49), Level::Weak);
    }
}
