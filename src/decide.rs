//! Pure keep-vs-strike decision. No I/O — this governs subtitle deletion, so
//! it stays isolated and exhaustively tested.
//!
//! - 0 alignments, some engine rejected a too-large shift → not fitting (strike)
//! - 0 alignments, engines only errored / timed out / were skipped → failed
//!   (no strike: a crash says nothing about whether the subtitle fits)
//! - 1 alignment: only one engine produced output → keep (a delete needs both)
//! - 2 alignments within threshold: engines agree → keep
//! - 2 alignments beyond threshold: engines disagree → not fitting (strike)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Keep,
    NotFitting,
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
        [] if mismatch_reports > 0 => Outcome::NotFitting,
        [] => Outcome::Failed,
        [_] => Outcome::Keep,
        [a, b, ..] => {
            if (a.shift_ms - b.shift_ms).abs() <= agreement_threshold_ms {
                Outcome::Keep
            } else {
                Outcome::NotFitting
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
    fn empty_with_mismatch_is_not_fitting() {
        assert_eq!(decide_outcome(&[], 5000, 1), Outcome::NotFitting);
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
    fn disagree_beyond_threshold() {
        assert_eq!(decide_outcome(&[al("alass", 0), al("ffsubsync", 5001)], 5000, 0), Outcome::NotFitting);
    }

    #[test]
    fn negative_shifts() {
        assert_eq!(decide_outcome(&[al("alass", -2000), al("ffsubsync", 2000)], 5000, 0), Outcome::Keep);
        assert_eq!(decide_outcome(&[al("alass", -4000), al("ffsubsync", 2000)], 5000, 0), Outcome::NotFitting);
    }
}
