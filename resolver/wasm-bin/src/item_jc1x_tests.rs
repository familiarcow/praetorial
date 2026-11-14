//! JC1x (D-JUDGECHAIN1a #1): the resolver SIGNS its not-found observations as part of the result.
use super::*;

fn sample(outcome: &str, obs: Vec<(String, u64)>) -> SubmittedResult {
    SubmittedResult {
        bet_id: 5,
        terms_hash: "t".repeat(64),
        outcome: outcome.to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 2,
        checked_until: 77,
        next_check_ns: if outcome.starts_with("RETRY") { Some(99) } else { None },
        judge_pair_index: 1,
        model_not_found: obs,
    }
}

#[test]
fn no_observations_leave_the_jc1s_buffer_byte_identical() {
    let a = submitted_result_borsh_buf("escrow.testnet", &sample("YES", vec![]));
    // JC1s layout: ... checked_until(8) judge_pair_index(4) and nothing after for YES
    assert_eq!(&a[a.len() - 4..], &1u32.to_le_bytes());
    let r = submitted_result_borsh_buf("escrow.testnet", &sample("RETRY", vec![]));
    assert_eq!(&r[r.len() - 8..], &99u64.to_le_bytes());
}

#[test]
fn observations_are_appended_last_as_borsh_vec_of_string_u64() {
    let base = submitted_result_borsh_buf("escrow.testnet", &sample("RETRY", vec![]));
    let with = submitted_result_borsh_buf("escrow.testnet", &sample("RETRY", vec![("a/b".to_string(), 123), ("c/d".to_string(), 456)]));
    assert_eq!(&with[..base.len()], &base[..], "everything before is unchanged");
    let mut tail = Vec::new();
    tail.extend_from_slice(&2u32.to_le_bytes());
    for (m, n) in [("a/b", 123u64), ("c/d", 456u64)] {
        tail.extend_from_slice(&(m.len() as u32).to_le_bytes());
        tail.extend_from_slice(m.as_bytes());
        tail.extend_from_slice(&n.to_le_bytes());
    }
    assert_eq!(&with[base.len()..], &tail[..]);
    // and also for non-RETRY outcomes
    let y0 = submitted_result_borsh_buf("escrow.testnet", &sample("YES", vec![]));
    let y1 = submitted_result_borsh_buf("escrow.testnet", &sample("YES", vec![("a/b".to_string(), 1)]));
    assert_eq!(&y1[..y0.len()], &y0[..]);
    assert_eq!(y1.len(), y0.len() + 4 + 4 + 3 + 8);
}

#[test]
fn each_observation_changes_the_signed_bytes() {
    let a = submitted_result_borsh_buf("escrow.testnet", &sample("RETRY", vec![("a/b".to_string(), 1)]));
    let b = submitted_result_borsh_buf("escrow.testnet", &sample("RETRY", vec![("a/b".to_string(), 2)]));
    assert_ne!(a, b);
}
