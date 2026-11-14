//! Red team loop: referee collusion + bond-grinding. Child of tests.rs
//! (`#[path]`), reuses its private helpers.
//! See Vault: Praetorial spec/Red team log.md (entry "referee collusion + bond-grinding").
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const DAY: u64 = 24 * 60 * 60 * 1_000_000_000;

fn limits(max_rounds: u32) -> Limits {
    Limits {
        max_stake: U128(crate::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
        max_offer_ttl_secs: 86400 * 60,
        max_stake_per_side_near: U128(100 * 10u128.pow(24)),
        max_rounds,
        max_retries: crate::DEFAULT_MAX_RETRIES,
    }
}

fn acct(s: &str) -> near_sdk::AccountId {
    s.parse().unwrap()
}

/// Opens + takes a bet (named taker, long resolve_deadline), optionally with a
/// referee, and submits the round-0 outcome at t=2_000.
fn setup(max_rounds: u32, mode: Option<RefereeMode>, seed: u8, round0: &str) -> (Contract, u64) {
    let mut c = new_contract_with_limits(limits(max_rounds), None);
    let (_sk, pk) = test_keypair(seed);
    let mut env = base_envelope(&hex_encode(&pk));
    env.taker_allow = TakerAllow::Account(acct("taker.testnet"));
    env.resolve_deadline = 365 * DAY;
    env.referee = mode.map(|m| Referee { account: acct("referee.testnet"), mode: m });
    assert_eq!(do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1), vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    let take = serde_json::to_string(&TransferMsg::Take {
        bet_id,
        invite_sig: None,
        tip: false,
        referee_ack: env.referee.as_ref().map(|r| r.account.clone()),
    })
    .unwrap();
    assert_eq!(do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take, 2), vec![U128(0)]);
    // RF2 / D-REFUI4: a human-referee bet is never AI-resolved.
    if env.referee.is_none() {
        submit(&mut c, bet_id, round0, 1, 2_000);
    }
    (c, bet_id)
}

fn submit(c: &mut Contract, bet_id: u64, outcome: &str, run_no: u64, ts: u64) {
    ctx("anyone.testnet", ts);
    let r = rr_result(bet_id, outcome, run_no, ts);
    c.submit_outcome(r.clone(), sign_result(&outcome_signing_key(), &r));
}

fn bond_msg(bet_id: u64, round: u32) -> String {
    serde_json::to_string(&TransferMsg::Bond { bet_id, round }).unwrap()
}

fn quote(c: &Contract, bet_id: u64, who: &str) -> u128 {
    c.required_challenge_bond(bet_id, acct(who)).unwrap().amount.0
}

fn post_bond(c: &mut Contract, who: &str, bet_id: u64, round: u32, ts: u64) -> Vec<U128> {
    let q = quote(c, bet_id, who);
    do_mt_transfer(c, who, q, bond_msg(bet_id, round), ts)
}

fn fails<F: FnOnce()>(f: F) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

// ===================================================================
// RED 1 (money / wrong-winner): finalize ignores a pending FinalSay
// window. The winner (or anyone) finalizes 24h after round-0's
// proposed_at while the referee still has 72h to rule; the challenger's
// bond (incl. the prepaid panel) is forfeited with no review at all.
// ===================================================================
// ===================================================================
// RED 2 (money / wrong-winner): last-minute challenge, instant finalize.
// Bond lands in the final seconds of round-0's window; the winner
// finalizes at once, before any re-judge could possibly run.
// ===================================================================
#[test]
fn rt_ref_finalize_must_wait_for_pending_rejudge() {
    let (mut c, bet_id) = setup(2, None, 231, "YES");
    let period = c.get_bet(bet_id).unwrap().envelope.settlement_period;
    let proposed_at = c.get_bet(bet_id).unwrap().proposed_at.unwrap();
    let t_bond = proposed_at + period - 10;
    assert_eq!(post_bond(&mut c, "taker.testnet", bet_id, 1, t_bond), vec![U128(0)]);
    ctx("maker.testnet", proposed_at + period);
    assert!(
        fails(|| c.finalize(bet_id)),
        "finalize must not forfeit a fresh bond before the re-judge had a chance to run"
    );
}

// Companion (must stay green after the fix): no stuck funds -- once a re-judge
// is impossible (resolve_deadline passed) finalize on the standing outcome works.
#[test]
fn rt_ref_finalize_allowed_when_rejudge_impossible_after_resolve_deadline() {
    let (mut c, bet_id) = setup(2, None, 232, "YES");
    let proposed_at = c.get_bet(bet_id).unwrap().proposed_at.unwrap();
    assert_eq!(post_bond(&mut c, "taker.testnet", bet_id, 1, proposed_at + 100), vec![U128(0)]);
    let dl = c.get_bet(bet_id).unwrap().envelope.resolve_deadline;
    ctx("maker.testnet", dl + 1);
    c.finalize(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
}

// ===================================================================
// RED 3 (money, small / griefing): `Bond.round` is caller-supplied and
// stored verbatim; `referee_rule` locates the prepaid-panel bond by
// `b.round == max_rounds`. A round-1 bond labelled `round: 2` captures
// the final-round panel refund meant for the real round-2 challenger.
// ===================================================================
// ===================================================================
// ALREADY BLOCKED -- regression pins
// ===================================================================
#[test]
fn rt_ref_blocked_referee_cannot_be_swapped_to_a_party_after_take() {
    let (mut c, bet_id) = setup(1, Some(RefereeMode::Human), 241, "YES");
    for party in ["taker.testnet", "maker.testnet"] {
        let j = serde_json::to_string(&Some(Referee { account: acct(party), mode: RefereeMode::Human })).unwrap();
        ctx("maker.testnet", 2_100);
        assert!(fails(|| c.amend_referee(bet_id, j.clone())), "referee == {party} must be refused");
        ctx("taker.testnet", 2_101);
        assert!(fails(|| c.amend_referee(bet_id, j.clone())));
    }
    assert_eq!(c.get_bet(bet_id).unwrap().envelope.referee.unwrap().account, acct("referee.testnet"));
}

#[test]
fn rt_ref_blocked_referee_and_outsiders_cannot_post_bonds() {
    let (mut c, bet_id) = setup(2, Some(RefereeMode::Human), 242, "YES");
    let q = quote(&c, bet_id, "taker.testnet");
    for who in ["referee.testnet", "evil.testnet"] {
        assert_eq!(do_mt_transfer(&mut c, who, q, bond_msg(bet_id, 1), 2_050), vec![U128(q)], "{who} bond must be refunded");
    }
    assert!(c.get_bet(bet_id).unwrap().bonds.is_empty());
}

#[test]
fn rt_ref_blocked_dust_wrong_amount_and_wrong_asset_bonds_refunded() {
    let (mut c, bet_id) = setup(2, None, 243, "YES");
    let q = quote(&c, bet_id, "taker.testnet");
    for amt in [1u128, q - 1, q + 1] {
        assert_eq!(do_mt_transfer(&mut c, "taker.testnet", amt, bond_msg(bet_id, 1), 2_050), vec![U128(amt)]);
    }
    assert!(c.get_bet(bet_id).unwrap().bonds.is_empty());
}

#[test]
fn rt_ref_blocked_round_counter_cannot_overflow_or_exceed_cap() {
    let (mut c, bet_id) = setup(2, None, 244, "YES");
    assert_eq!(post_bond(&mut c, "taker.testnet", bet_id, 1, 2_050), vec![U128(0)]);
    ctx("maker.testnet", 2_060);
    c.submit_exhibits(bet_id, vec!["h".repeat(64)]);
    assert_eq!(do_mt_transfer(&mut c, "maker.testnet", 10_005_000, bond_msg(bet_id, u32::MAX), 2_070), vec![U128(0)]);
    // cap reached: any further bond (any label, either party, any amount) is refunded.
    for (who, amt) in [("taker.testnet", 20_005_000u128), ("maker.testnet", 5_005_000), ("taker.testnet", 5_005_000)] {
        assert_eq!(do_mt_transfer(&mut c, who, amt, bond_msg(bet_id, u32::MAX), 2_080), vec![U128(amt)]);
    }
    assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 2);
}

// ===================================================================
// rt-ref-gate (D-RTREF1 option A): a FinalSay referee may rule only once the
// AI runs for every pre-final round (round 0 + each non-final challenge round
// = max_rounds landed results) are recorded.
// ===================================================================