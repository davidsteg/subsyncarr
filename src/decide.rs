//! Pure keep-vs-strike decision. No I/O — this governs subtitle deletion, so
//! it stays isolated and exhaustively tested.
//!
//! - 0 alignments, both engines rejected a too-large shift → not fitting (strike)
//! - 0 alignments, only one engine rejected a too-large shift → unconfirmed
//!   (no strike: a delete needs both engines to say so)
//! - 0 alignments, engines only errored / timed out / were skipped → failed
//!   (no strike: a crash says nothing about whether the subtitle fits)
//! - 1 alignment from ffsubsync under [`NEGLIGIBLE_SHIFT_MS`] → already in
//!   sync (the second engine is skipped, see `processor::run_chain`)
//! - 1 alignment, the other engine rejected a too-large shift: ffsubsync under
//!   [`IN_SYNC_MS`] → already in sync, otherwise → unconfirmed (one engine's
//!   word is not enough to rewrite a subtitle the other says doesn't fit)
//! - 1 alignment, the other engine only errored → keep
//! - 2 alignments within threshold: engines agree → keep
//! - 2 alignments beyond threshold, ffsubsync shift under [`IN_SYNC_MS`] →
//!   already in sync (left untouched, no strike)
//! - 2 alignments beyond threshold, both shifts above [`IN_SYNC_MS`] →
//!   not fitting (strike)
//! - 2 alignments beyond threshold, otherwise → unconfirmed (no strike)

/// ffsubsync finding less than this shift means the subtitle already fits.
pub const IN_SYNC_MS: i64 = 1000;

/// ffsubsync finding less than this shift settles the file on its own: the
/// second engine isn't run, and nothing is rewritten.
pub const NEGLIGIBLE_SHIFT_MS: i64 = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Keep,
    /// ffsubsync sees (almost) no shift while the other engine wanders off:
    /// the subtitle is already in sync and stays as it is.
    InSync,
    NotFitting,
    /// The engines disagree, but not both want a large shift: no strike.
    Unconfirmed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct Alignment {
    pub engine: String,
    pub shift_ms: i64,
}

/// `mismatch_reports`: engines that ran and rejected their result as a
/// too-large shift — evidence the subtitle belongs to a different cut.
pub fn decide_outcome(alignments: &[Alignment], agreement_threshold_ms: i64, mismatch_reports: usize) -> Outcome {
    match alignments {
        [] if mismatch_reports >= 2 => Outcome::NotFitting,
        [] if mismatch_reports == 1 => Outcome::Unconfirmed,
        [] => Outcome::Failed,
        [a] => {
            let ffsubsync_within = |ms: i64| a.engine == "ffsubsync" && a.shift_ms.abs() < ms;
            if ffsubsync_within(NEGLIGIBLE_SHIFT_MS) {
                Outcome::InSync
            } else if mismatch_reports == 0 {
                Outcome::Keep
            } else if ffsubsync_within(IN_SYNC_MS) {
                Outcome::InSync
            } else {
                Outcome::Unconfirmed
            }
        }
        [a, b, ..] => {
            if (a.shift_ms - b.shift_ms).abs() <= agreement_threshold_ms {
                Outcome::Keep
            } else if [a, b].iter().any(|x| x.engine == "ffsubsync" && x.shift_ms.abs() < IN_SYNC_MS) {
                Outcome::InSync
            } else if a.shift_ms.abs() >= IN_SYNC_MS && b.shift_ms.abs() >= IN_SYNC_MS {
                Outcome::NotFitting
            } else {
                Outcome::Unconfirmed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn al(engine: &str, shift_ms: i64) -> Alignment {
        Alignment { engine: engine.into(), shift_ms }
    }

    #[test]
    fn both_rejected_is_not_fitting() {
        assert_eq!(decide_outcome(&[], 5000, 2), Outcome::NotFitting);
    }

    #[test]
    fn one_rejected_is_unconfirmed() {
        assert_eq!(decide_outcome(&[], 5000, 1), Outcome::Unconfirmed);
    }

    #[test]
    fn empty_without_mismatch_is_failed() {
        assert_eq!(decide_outcome(&[], 5000, 0), Outcome::Failed);
    }

    #[test]
    fn mismatch_reports_ignored_when_engines_agree() {
        assert_eq!(decide_outcome(&[al("alass", 0), al("ffsubsync", 10)], 5000, 1), Outcome::Keep);
    }

    #[test]
    fn single_is_keep() {
        assert_eq!(decide_outcome(&[al("alass", 99_999)], 5000, 0), Outcome::Keep);
        assert_eq!(decide_outcome(&[al("ffsubsync", 600)], 5000, 0), Outcome::Keep);
    }

    #[test]
    fn single_ffsubsync_negligible_is_in_sync() {
        assert_eq!(decide_outcome(&[al("ffsubsync", 0)], 5000, 0), Outcome::InSync);
        assert_eq!(decide_outcome(&[al("ffsubsync", -249)], 5000, 0), Outcome::InSync);
        assert_eq!(decide_outcome(&[al("alass", 0)], 5000, 0), Outcome::Keep);
    }

    #[test]
    fn single_with_other_rejected_is_not_kept() {
        // The production pattern: one engine lands near the 30 s limit, the
        // other wants even more. Never rewrite on that alone.
        assert_eq!(decide_outcome(&[al("alass", 28_000)], 5000, 1), Outcome::Unconfirmed);
        assert_eq!(decide_outcome(&[al("ffsubsync", 27_500)], 5000, 1), Outcome::Unconfirmed);
        assert_eq!(decide_outcome(&[al("ffsubsync", 600)], 5000, 1), Outcome::InSync);
    }

    #[test]
    fn agree_within_threshold() {
        assert_eq!(decide_outcome(&[al("alass", 1000), al("ffsubsync", 3000)], 5000, 0), Outcome::Keep);
    }

    #[test]
    fn exact_threshold_is_keep() {
        assert_eq!(decide_outcome(&[al("alass", 0), al("ffsubsync", 5000)], 5000, 0), Outcome::Keep);
    }

    #[test]
    fn disagree_with_both_large_is_not_fitting() {
        assert_eq!(decide_outcome(&[al("alass", 2000), al("ffsubsync", 9000)], 5000, 0), Outcome::NotFitting);
        assert_eq!(decide_outcome(&[al("alass", -4000), al("ffsubsync", 2000)], 5000, 0), Outcome::NotFitting);
    }

    #[test]
    fn ffsubsync_near_zero_is_in_sync() {
        // The production pattern: alass +15–25 s, ffsubsync ~0.
        assert_eq!(decide_outcome(&[al("alass", 18_000), al("ffsubsync", 40)], 5000, 0), Outcome::InSync);
        assert_eq!(decide_outcome(&[al("ffsubsync", -999), al("alass", -25_000)], 5000, 0), Outcome::InSync);
        assert_eq!(decide_outcome(&[al("alass", 18_000), al("ffsubsync", 1000)], 5000, 0), Outcome::NotFitting);
    }

    #[test]
    fn only_alass_near_zero_is_unconfirmed() {
        assert_eq!(decide_outcome(&[al("alass", 0), al("ffsubsync", 20_000)], 5000, 0), Outcome::Unconfirmed);
        assert_eq!(decide_outcome(&[al("alass", 0), al("autosubsync", 20_000)], 5000, 0), Outcome::Unconfirmed);
    }
}
