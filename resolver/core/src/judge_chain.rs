//! JC1s (D-JUDGECHAIN1, D-JUDGECHAIN1a): the pure retirement rule and first-live-pair walk.
//! "Retired" = the provider answered not-found (404/410) on 3 observations, each at least 24h after the previous one.
//! One place only; the resolver and (later) JC1x's contract mirror use this exact rule.
use std::collections::BTreeMap;

/// 24h in nanoseconds: the minimum gap between two not-found checks that count as separate observations.
pub const RETIRE_MIN_GAP_NS: u64 = 24 * 3_600 * 1_000_000_000;
/// Number of gap-separated not-found checks that retire a model.
pub const RETIRE_OBSERVATIONS: usize = 3;

/// True iff `obs` (unix ns of 404/410 answers, any order) contains 3 observations each >= 24h after the previous one
/// (greedy from the earliest). Errors/timeouts are never recorded here (they are an outage, not a retirement).
pub fn model_retired(obs: &[u64]) -> bool {
    let mut v: Vec<u64> = obs.to_vec();
    v.sort_unstable();
    let mut count = 0usize;
    let mut last: Option<u64> = None;
    for t in v {
        if last.map_or(true, |l| t >= l.saturating_add(RETIRE_MIN_GAP_NS)) {
            count += 1;
            last = Some(t);
            if count >= RETIRE_OBSERVATIONS {
                return true;
            }
        }
    }
    false
}

/// Adds a fresh not-found observation. Kept sorted; an observation less than 24h after the last kept one is not a new
/// check and is dropped; capped at RETIRE_OBSERVATIONS (a retired model does not grow).
pub fn add_observation(obs: &[u64], ts: u64) -> Vec<u64> {
    let mut v: Vec<u64> = obs.to_vec();
    v.sort_unstable();
    if v.len() >= RETIRE_OBSERVATIONS {
        return v;
    }
    if v.last().map_or(true, |l| ts >= l.saturating_add(RETIRE_MIN_GAP_NS)) {
        v.push(ts);
    }
    v
}

/// Index of the first chain pair whose two models are both live (neither retired), or None when the whole chain is gone.
pub fn first_live_pair(chain: &[(String, String)], missing: &BTreeMap<String, Vec<u64>>) -> Option<usize> {
    let retired = |m: &String| missing.get(m).map_or(false, |o| model_retired(o));
    chain.iter().position(|(a, b)| !retired(a) && !retired(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    const H: u64 = 3_600 * 1_000_000_000;
    const D: u64 = 24 * H;
    const T0: u64 = 1_800_000_000 * 1_000_000_000;

    fn pair(a: &str, b: &str) -> (String, String) {
        (a.to_string(), b.to_string())
    }

    #[test]
    fn fewer_than_three_observations_never_retire() {
        assert!(!model_retired(&[]));
        assert!(!model_retired(&[T0]));
        assert!(!model_retired(&[T0, T0 + 2 * D]));
    }
    #[test]
    fn three_observations_exactly_24h_apart_retire() {
        assert!(model_retired(&[T0, T0 + D, T0 + 2 * D]));
    }
    #[test]
    fn three_observations_over_48h_with_slack_retire_and_order_does_not_matter() {
        assert!(model_retired(&[T0 + 2 * D + 5, T0, T0 + D + 1]));
    }
    #[test]
    fn a_burst_inside_24h_counts_once() {
        assert!(!model_retired(&[T0, T0 + H, T0 + 2 * H]));
        assert!(!model_retired(&[T0, T0 + H, T0 + D])); // only 2 gap-separated checks
        assert!(!model_retired(&[T0, T0 + D - 1, T0 + 2 * D - 2]));
    }
    #[test]
    fn add_observation_ignores_a_repeat_inside_24h_and_keeps_order() {
        let a = add_observation(&[], T0);
        assert_eq!(a, vec![T0]);
        assert_eq!(add_observation(&a, T0 + H), a, "inside 24h of the last kept observation: not a new check");
        let b = add_observation(&a, T0 + D);
        assert_eq!(b, vec![T0, T0 + D]);
        let c = add_observation(&b, T0 + 2 * D);
        assert_eq!(c, vec![T0, T0 + D, T0 + 2 * D]);
        assert!(model_retired(&c));
        assert_eq!(add_observation(&c, T0 + 9 * D), c, "capped at 3: a retired model stays retired, no growth");
    }
    #[test]
    fn single_not_found_is_not_a_retirement() {
        assert!(!model_retired(&add_observation(&[], T0)));
    }
    #[test]
    fn first_live_pair_walks_in_order_and_skips_a_pair_with_either_model_retired() {
        let chain = vec![pair("p/a", "p/b"), pair("q/a", "q/b"), pair("r/a", "r/b")];
        let mut missing: BTreeMap<String, Vec<u64>> = BTreeMap::new();
        assert_eq!(first_live_pair(&chain, &missing), Some(0));
        missing.insert("p/a".into(), vec![T0, T0 + D]); // 2 observations: still live
        assert_eq!(first_live_pair(&chain, &missing), Some(0));
        missing.insert("p/b".into(), vec![T0, T0 + D, T0 + 2 * D]); // either model of the pair retired -> pair is dead
        assert_eq!(first_live_pair(&chain, &missing), Some(1));
        missing.insert("r/a".into(), vec![T0, T0 + D, T0 + 2 * D]);
        assert_eq!(first_live_pair(&chain, &missing), Some(1), "a live earlier pair always wins");
        missing.insert("q/a".into(), vec![T0, T0 + D, T0 + 2 * D]);
        assert_eq!(first_live_pair(&chain, &missing), None, "whole chain gone");
    }
    #[test]
    fn empty_chain_has_no_live_pair() {
        assert_eq!(first_live_pair(&[], &BTreeMap::new()), None);
    }
}
