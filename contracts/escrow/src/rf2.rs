//! RF2 (D-REFUI4, with D-REFUI3a/3b): referee-v1. A bet is decided by exactly
//! one method: the AI (default, unchanged) or a named human referee who rules
//! YES/NO/VOID via `referee_rule` and is paid out immediately. Child of
//! tests.rs (`#[path]`), reuses its private helpers.
//!
//! Tip model under test: a per-bettor opt-in (maker at open, taker at take) of
//! `max(stake * bet.fee_bps / 10000, bet.fee_min_*)`, CARVED OUT of that
//! bettor's own stake (deposits are unchanged), paid to the referee on every
//! ending after the take, refunded by construction on cancel/expire/
//! emergency_refund (the full deposit goes back), absent in AI mode.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const DAY: u64 = 24 * 60 * 60 * 1_000_000_000;
const REF: &str = "referee.testnet";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn fails<F: FnOnce()>(f: F) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

fn human() -> Option<Referee> {
    Some(Referee { account: acct(REF), mode: RefereeMode::Human })
}

/// Same-asset (USDC) human-referee envelope: stake 1_000_000 each side, fee
/// 1% = 10_000, storage 10_000 per side. funding_deadline 1_000,
/// resolve_deadline 365 days.
fn h_env() -> Envelope {
    let mut env = base_envelope("");
    env.referee = human();
    env.resolve_deadline = 365 * DAY;
    env
}

fn take_h(bet_id: u64, tip: bool, ack: Option<&str>) -> String {
    serde_json::to_string(&TransferMsg::Take {
        bet_id,
        invite_sig: None,
        tip,
        referee_ack: ack.map(acct),
    })
    .unwrap()
}

fn open_h(c: &mut Contract, env: &Envelope) -> u64 {
    let r = do_mt_transfer(c, "maker.testnet", env.maker_required(), open_msg(env), 1);
    assert_eq!(r, vec![U128(0)], "open must be accepted");
    c.next_bet_id - 1
}

fn take_ok(c: &mut Contract, bet_id: u64, env: &Envelope, tip: bool) {
    let ack = env.referee.as_ref().map(|r| r.account.to_string());
    let r = do_mt_transfer(c, "taker.testnet", env.taker_required(), take_h(bet_id, tip, ack.as_deref()), 2);
    assert_eq!(r, vec![U128(0)], "take must be accepted");
}

fn open_take(c: &mut Contract, env: &Envelope, taker_tip: bool) -> u64 {
    let id = open_h(c, env);
    take_ok(c, id, env, taker_tip);
    id
}

fn rule(c: &mut Contract, who: &str, bet_id: u64, outcome: &str, ts: u64) {
    ctx(who, ts);
    c.referee_rule(bet_id, outcome.to_string());
}

fn lines(c: &Contract, bet_id: u64) -> Vec<PendingPayout> {
    c.payout_ids_in_order()
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .filter(|p| p.bet_id == bet_id)
        .collect()
}

fn sum_to(c: &Contract, bet_id: u64, who: &str, asset: &str) -> u128 {
    lines(c, bet_id)
        .iter()
        .filter(|p| p.receiver == acct(who) && p.token_id == asset)
        .map(|p| p.amount.0)
        .sum()
}

/// I-2 / I-1 per asset: everything scheduled for the bet equals what was deposited.
fn assert_conserved(c: &Contract, bet_id: u64, deposited: &[(&str, u128)]) {
    for (asset, dep) in deposited {
        let out: u128 = lines(c, bet_id).iter().filter(|p| p.token_id == *asset).map(|p| p.amount.0).sum();
        assert_eq!(out, *dep, "I-2: scheduled payouts in {asset} must equal deposits");
    }
}

const DEP: u128 = 1_010_000; // stake 1_000_000 + storage 10_000, per side

// ---------------------------------------------------------------- rulings

#[test]
fn rf2_referee_rules_yes_pays_out_immediately() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
    rule(&mut c, REF, id, "YES", 1_001);
    let bet = c.get_bet(id).unwrap();
    assert_eq!(bet.status, BetStatus::Finalized, "no settlement window: paid at the ruling");
    assert_eq!(bet.outcome.as_deref(), Some("YES"));
    // maker_side is YES -> maker wins both pots minus 1% each.
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_980_000);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 0, "no payout to the loser");
    assert_eq!(sum_to(&c, id, REF, USDC), 0, "no tip opted in -> referee earns nothing");
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
    drain_all(&mut c, id, 1_002);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Settled);
}

#[test]
fn rf2_referee_rules_no_pays_taker() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    rule(&mut c, REF, id, "NO", 1_001);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Finalized);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 1_980_000);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 0, "no payout to the loser");
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_referee_rules_void_refunds_both_stakes() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    rule(&mut c, REF, id, "VOID", 1_001);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Finalized);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_000_000);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 1_000_000);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_ruling_before_funding_deadline_refused() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    ctx(REF, 999); // funding_deadline = 1_000
    assert!(fails(|| c.referee_rule(id, "YES".into())), "ruling before funding_deadline must be refused");
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
    // exactly at funding_deadline is allowed ("from funding_deadline")
    rule(&mut c, REF, id, "YES", 1_000);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Finalized);
}

#[test]
fn rf2_ruling_after_resolve_deadline_refused() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    ctx(REF, 365 * DAY + 1);
    assert!(fails(|| c.referee_rule(id, "YES".into())), "ruling after resolve_deadline must be refused");
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
    // the last allowed instant is resolve_deadline itself
    rule(&mut c, REF, id, "NO", 365 * DAY);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Finalized);
}

#[test]
fn rf2_non_referee_cannot_rule() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    for who in ["maker.testnet", "taker.testnet", "anyone.testnet", "fee.testnet", "guardian.testnet", "operator.testnet"] {
        ctx(who, 1_500);
        assert!(fails(|| c.referee_rule(id, "YES".into())), "{who} must not be able to rule");
    }
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
    assert!(lines(&c, id).is_empty(), "no payout scheduled by refused rulings");
}

#[test]
fn rf2_ruling_rejects_garbage_and_cannot_repeat() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    ctx(REF, 1_500);
    assert!(fails(|| c.referee_rule(id, "MAYBE".into())));
    rule(&mut c, REF, id, "YES", 1_501);
    ctx(REF, 1_502);
    assert!(fails(|| c.referee_rule(id, "NO".into())), "a ruling is final: no second ruling");
    assert_eq!(c.get_bet(id).unwrap().outcome.as_deref(), Some("YES"));
}

#[test]
fn rf2_referee_rule_on_open_untaken_offer_refused() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_h(&mut c, &env);
    ctx(REF, 1_500);
    assert!(fails(|| c.referee_rule(id, "YES".into())), "an untaken offer cannot be ruled on");
}

#[test]
fn rf2_referee_rule_on_ai_bet_refused() {
    let mut c = new_contract();
    let env = base_envelope(""); // no referee
    let id = open_take(&mut c, &env, false);
    ctx(REF, 1_500);
    assert!(fails(|| c.referee_rule(id, "YES".into())));
}

// ------------------------------------------- AI paths refused in human mode

#[test]
fn rf2_request_resolution_refused_in_human_mode() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    assert!(
        c.can_request_resolution(id).is_some(),
        "dry-run view must also refuse (no AI run in human mode)"
    );
    ctx_with_deposit("anyone.testnet", 1_500, NearToken::from_near(1));
    assert!(fails(|| {
        let _ = c.request_resolution(id, None);
    }));
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken, "no AI run started");
    assert!(c.get_bet(id).unwrap().pending_resolution_request.is_none());
}

#[test]
fn rf2_submit_outcome_refused_in_human_mode() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    ctx("anyone.testnet", 1_500);
    let result = SubmittedResult {
        bet_id: id,
        terms_hash: env.terms_hash.clone(),
        outcome: "NO".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(1_500),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    assert!(fails(|| c.submit_outcome(result, sig)), "no AI-signed outcome may land in human mode");
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
}

#[test]
fn rf2_bond_challenge_and_extend_window_refused_in_human_mode() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    // challenge bond (any amount) bounces in full
    let r = do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000,
        serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(),
        1_500,
    );
    assert_eq!(r, vec![U128(5_005_000)], "bond refunded in full");
    let r = do_mt_transfer(
        &mut c,
        "maker.testnet",
        1_000_000,
        serde_json::to_string(&TransferMsg::Objection { bet_id: id, exhibit_hash: "h".repeat(64), is_rebuttal: false }).unwrap(),
        1_500,
    );
    assert_eq!(r, vec![U128(1_000_000)], "objection deposit refunded in full");
    ctx("maker.testnet", 1_501);
    assert!(fails(|| c.extend_window(id)));
    // and after a ruling, still nothing to challenge or extend
    rule(&mut c, REF, id, "YES", 1_600);
    let r = do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000,
        serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(),
        1_601,
    );
    assert_eq!(r, vec![U128(5_005_000)]);
    ctx("taker.testnet", 1_602);
    assert!(fails(|| c.extend_window(id)));
    assert!(c.get_bet(id).unwrap().bonds.is_empty());
}

#[test]
fn rf2_silent_referee_void_after_deadline_refunds_everyone() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    ctx("anyone.testnet", 365 * DAY); // not yet past resolve_deadline
    assert!(fails(|| c.void_after_deadline(id)));
    ctx("anyone.testnet", 365 * DAY + 1);
    c.void_after_deadline(id);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Voided);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_000_000, "maker stake back; storage goes to the fee account (keep_terms)");
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 1_000_000);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
    // the referee can no longer rule
    ctx(REF, 365 * DAY + 2);
    assert!(fails(|| c.referee_rule(id, "YES".into())));
}

// ------------------------------------------------------ switching to AI

#[test]
fn rf2_both_sign_switch_to_ai_then_ai_resolves_and_tips_vanish() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, true);
    assert_eq!(c.get_bet(id).unwrap().tip_maker.0, 10_000, "maker tip reserved at open");
    assert_eq!(c.get_bet(id).unwrap().tip_taker.0, 10_000, "taker tip reserved at take");
    // one signature alone changes nothing
    ctx("maker.testnet", 1_100);
    c.amend_referee(id, "null".to_string());
    assert!(c.get_bet(id).unwrap().envelope.referee.is_some(), "needs both signatures");
    ctx("taker.testnet", 1_101);
    c.amend_referee(id, "null".to_string());
    let bet = c.get_bet(id).unwrap();
    assert!(bet.envelope.referee.is_none(), "now AI mode");
    assert_eq!((bet.tip_maker.0, bet.tip_taker.0), (0, 0), "no tip in AI mode");
    // the old referee can't rule any more
    ctx(REF, 1_200);
    assert!(fails(|| c.referee_rule(id, "NO".into())));
    // AI resolves through the normal path
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id: id,
        terms_hash: env.terms_hash.clone(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Proposed);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(id);
    assert_eq!(sum_to(&c, id, REF, USDC), 0, "no tip paid in AI mode");
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_980_000, "full stakes less protocol fee only");
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_switch_to_ai_refused_after_ruling() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    rule(&mut c, REF, id, "YES", 1_001);
    ctx("maker.testnet", 1_100);
    assert!(fails(|| c.amend_referee(id, "null".to_string())), "frozen once the referee has ruled");
    ctx("taker.testnet", 1_101);
    assert!(fails(|| c.amend_referee(id, "null".to_string())));
}

#[test]
fn rf2_amend_referee_after_take_never_names_a_party_or_fee_account() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    for bad in ["maker.testnet", "taker.testnet", "fee.testnet"] {
        let json = serde_json::to_string(&Some(Referee { account: acct(bad), mode: RefereeMode::Human })).unwrap();
        ctx("maker.testnet", 1_100);
        assert!(fails(|| c.amend_referee(id, json.clone())), "{bad} must be refused as referee");
        ctx("taker.testnet", 1_101);
        assert!(fails(|| c.amend_referee(id, json.clone())), "{bad} must be refused as referee");
    }
    assert_eq!(c.get_bet(id).unwrap().envelope.referee, human());
}

#[test]
fn rf2_amend_referee_frozen_once_a_dispute_opens() {
    // AI-mode bet, challenged: switching to a human referee must be refused (dispute underway).
    let mut c = new_contract();
    let env = base_envelope("");
    let id = open_take(&mut c, &env, false);
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id: id,
        terms_hash: env.terms_hash.clone(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    let q = c.required_challenge_bond(id, acct("taker.testnet")).unwrap().amount.0;
    assert_eq!(
        do_mt_transfer(&mut c, "taker.testnet", q, serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), 2_050),
        vec![U128(0)]
    );
    let json = serde_json::to_string(&human()).unwrap();
    ctx("maker.testnet", 2_100);
    assert!(fails(|| c.amend_referee(id, json.clone())));
    ctx("taker.testnet", 2_101);
    assert!(fails(|| c.amend_referee(id, json.clone())));
    assert!(c.get_bet(id).unwrap().envelope.referee.is_none());
}

// ------------------------------------- RA1: freeze after the take (D-REFUI4a)

const RA1_MSG: &str = "referee frozen once a decision or dispute starts";

fn panic_text<F: FnOnce()>(f: F) -> String {
    let e = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    e.downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

/// Both parties try `json`; each call must be refused with the RA1 message.
fn ra1_both_refused(c: &mut Contract, id: u64, json: &str, what: &str) {
    for who in ["maker.testnet", "taker.testnet"] {
        ctx(who, 2_100);
        let m = panic_text(|| c.amend_referee(id, json.to_string()));
        assert!(m.contains(RA1_MSG), "{what} by {who}: wrong refusal: {m}");
    }
}

#[test]
fn ra1_set_referee_refused_in_every_decision_or_dispute_status() {
    let set = serde_json::to_string(&human()).unwrap();
    for (i, st) in [
        BetStatus::Resolving,
        BetStatus::Proposed,
        BetStatus::Challenged,
        BetStatus::Evidence,
        BetStatus::Rejudge,
    ]
    .into_iter()
    .enumerate()
    {
        let st2 = st.clone();
        let set = set.clone();
        c1_isolated(move || {
            let (mut c, id) = c1_bet_in(st2.clone(), 200 + i as u8);
            assert!(c.get_bet(id).unwrap().envelope.referee.is_none(), "AI-mode start");
            ra1_both_refused(&mut c, id, &set, &format!("set referee in {st2:?}"));
            let bet = c.get_bet(id).unwrap();
            assert!(bet.envelope.referee.is_none(), "{st2:?}: referee must not change");
            assert!(bet.referee_proposal.maker_value.is_none() && bet.referee_proposal.taker_value.is_none(), "{st2:?}: no proposal may be recorded");
        });
    }
}

#[test]
fn ra1_switch_to_null_refused_where_a_referee_bet_can_be_in_the_status() {
    // Human-referee bets cannot enter Resolving/Proposed/Challenged/Evidence
    // (request_resolution is refused), so only Rejudge (status forced, as c1
    // does) is reachable for a referee bet.
    let mut c = new_contract();
    let id = open_take(&mut c, &h_env(), true);
    c.bets.get_mut(&id).unwrap().status = BetStatus::Rejudge;
    ra1_both_refused(&mut c, id, "null", "switch to null in Rejudge");
    let bet = c.get_bet(id).unwrap();
    assert_eq!(bet.envelope.referee, human());
    assert_eq!(bet.tip_taker.0, 10_000, "tips untouched");
}

#[test]
fn ra1_amend_still_allowed_in_taken_both_directions() {
    // referee -> null (tips cleared, as today)
    let mut c = new_contract();
    let id = open_take(&mut c, &h_env(), true);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
    ctx("maker.testnet", 1_100);
    c.amend_referee(id, "null".to_string());
    ctx("taker.testnet", 1_101);
    c.amend_referee(id, "null".to_string());
    let bet = c.get_bet(id).unwrap();
    assert!(bet.envelope.referee.is_none());
    assert_eq!((bet.tip_maker.0, bet.tip_taker.0), (0, 0));
    // null -> referee (AI-mode bet taken, then both name one)
    c1_isolated(|| {
        let mut c = new_contract();
        let id = open_take(&mut c, &base_envelope(""), false);
        assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
        let set = serde_json::to_string(&human()).unwrap();
        ctx("maker.testnet", 1_100);
        c.amend_referee(id, set.clone());
        ctx("taker.testnet", 1_101);
        c.amend_referee(id, set);
        assert_eq!(c.get_bet(id).unwrap().envelope.referee, human());
    });
}

// ----------------------------------------------- taking = agreeing

#[test]
fn rf2_referee_cannot_take_their_own_bet() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_h(&mut c, &env);
    let r = do_mt_transfer(&mut c, REF, env.taker_required(), take_h(id, false, Some(REF)), 2);
    assert_eq!(r, vec![U128(env.taker_required())], "referee = taker refused at take, full refund");
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Open);
}

#[test]
fn rf2_open_referee_allowed_without_named_taker_and_may_be_any_other_account() {
    // named-taker requirement is gone: TakerAllow::Any + a referee opens fine.
    let mut c = new_contract();
    let env = h_env();
    assert!(matches!(env.taker_allow, TakerAllow::Any));
    let id = open_h(&mut c, &env);
    assert_eq!(c.get_bet(id).unwrap().envelope.referee, human());
}

#[test]
fn rf2_referee_still_cannot_be_maker_fee_account_or_named_taker() {
    for (who, named) in [("maker.testnet", false), ("fee.testnet", false), ("taker.testnet", true)] {
        let mut c = new_contract();
        let mut env = h_env();
        env.referee = Some(Referee { account: acct(who), mode: RefereeMode::Human });
        if named {
            env.taker_allow = TakerAllow::Account(acct("taker.testnet"));
        }
        let r = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        assert_eq!(r, vec![U128(env.maker_required())], "{who} must be refused as referee at open");
    }
}

#[test]
fn rf2_take_must_acknowledge_the_current_referee() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_h(&mut c, &env);
    let req = env.taker_required();
    let r = do_mt_transfer(&mut c, "taker.testnet", req, take_h(id, false, None), 2);
    assert_eq!(r, vec![U128(req)], "no referee_ack on a referee bet: refused");
    let r = do_mt_transfer(&mut c, "taker.testnet", req, take_h(id, false, Some("someoneelse.testnet")), 2);
    assert_eq!(r, vec![U128(req)], "wrong referee_ack: refused");
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Open);
    take_ok(&mut c, id, &env, false);
}

#[test]
fn rf2_old_referee_modes_refused_at_open() {
    for old in ["Witness", "Source", "FinalSay"] {
        let mut c = new_contract();
        let env = h_env();
        let mut msg: serde_json::Value = serde_json::from_str(&open_msg(&env)).unwrap();
        msg["envelope"]["referee"]["mode"] = serde_json::Value::String(old.to_string());
        let r = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg.to_string(), 1);
        assert_eq!(r, vec![U128(env.maker_required())], "mode {old} is gone (D-REFUI4): open refused");
    }
}

// --------------------------------------------- maker edits untaken offer

#[test]
fn rf2_maker_edits_referee_alone_while_untaken() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_h(&mut c, &env);
    let other = serde_json::to_string(&Some(Referee { account: acct("referee2.testnet"), mode: RefereeMode::Human })).unwrap();
    ctx("maker.testnet", 100);
    c.amend_referee(id, other);
    assert_eq!(c.get_bet(id).unwrap().envelope.referee.unwrap().account, acct("referee2.testnet"));
    // a stranger cannot edit it
    let third = serde_json::to_string(&Some(Referee { account: acct("referee3.testnet"), mode: RefereeMode::Human })).unwrap();
    ctx("anyone.testnet", 101);
    assert!(fails(|| c.amend_referee(id, third.clone())));
    // maker may remove it entirely
    ctx("maker.testnet", 102);
    c.amend_referee(id, "null".to_string());
    assert!(c.get_bet(id).unwrap().envelope.referee.is_none());
    // the edit rules still hold: never the maker or fee account
    let bad = serde_json::to_string(&Some(Referee { account: acct("maker.testnet"), mode: RefereeMode::Human })).unwrap();
    ctx("maker.testnet", 103);
    assert!(fails(|| c.amend_referee(id, bad)));
}

#[test]
fn rf2_maker_edit_to_ai_returns_the_reserved_maker_tip() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_h(&mut c, &env);
    assert_eq!(c.get_bet(id).unwrap().tip_maker.0, 10_000);
    ctx("maker.testnet", 100);
    c.amend_referee(id, "null".to_string());
    assert_eq!(c.get_bet(id).unwrap().tip_maker.0, 0, "no referee -> no tip");
    take_ai_and_finish_ok(&mut c, id);
}

fn take_ai_and_finish_ok(c: &mut Contract, id: u64) {
    let r = do_mt_transfer(c, "taker.testnet", DEP, take_msg(id), 2);
    assert_eq!(r, vec![U128(0)]);
    ctx("taker.testnet", 3);
    c.concede(id);
    assert_eq!(sum_to(c, id, REF, USDC), 0);
    assert_conserved(c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_maker_cannot_edit_alone_after_take() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, false);
    let other = serde_json::to_string(&Some(Referee { account: acct("referee2.testnet"), mode: RefereeMode::Human })).unwrap();
    ctx("maker.testnet", 100);
    c.amend_referee(id, other);
    assert_eq!(c.get_bet(id).unwrap().envelope.referee, human(), "after the take the maker alone changes nothing");
}

// ---------------------------------------------------------------- tips

#[test]
fn rf2_tip_one_sided_maker_only() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, false);
    let bet = c.get_bet(id).unwrap();
    assert_eq!((bet.tip_maker.0, bet.tip_taker.0), (10_000, 0));
    rule(&mut c, REF, id, "YES", 1_001);
    assert_eq!(sum_to(&c, id, REF, USDC), 10_000, "referee earns the maker's tip");
    // maker wins: (1M - fee 10k - tip 10k) + (1M - fee 10k)
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_970_000);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_tip_both_sides_paid_on_a_decisive_ruling() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, true);
    rule(&mut c, REF, id, "NO", 1_001);
    assert_eq!(sum_to(&c, id, REF, USDC), 20_000);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 1_960_000);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 0);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_tip_is_paid_even_when_the_referee_rules_void() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, true);
    rule(&mut c, REF, id, "VOID", 1_001);
    assert_eq!(sum_to(&c, id, REF, USDC), 20_000, "no incentive to prefer a decisive result");
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 990_000);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 990_000);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_tip_taker_only() {
    let mut c = new_contract();
    let env = h_env();
    let id = open_take(&mut c, &env, true);
    let bet = c.get_bet(id).unwrap();
    assert_eq!((bet.tip_maker.0, bet.tip_taker.0), (0, 10_000));
    rule(&mut c, REF, id, "YES", 1_001);
    assert_eq!(sum_to(&c, id, REF, USDC), 10_000);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_970_000);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_tip_cross_asset_is_per_own_asset() {
    let mut c = new_contract_spec_assets();
    let mut env = h_env();
    env.maker_asset = USDC.to_string();
    env.taker_asset = MOCK_BTC.to_string();
    env.stake_maker = U128(5_000_000);
    env.stake_taker = U128(10_000);
    env.tip_maker = true;
    let r = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(r, vec![U128(0)]);
    let id = c.next_bet_id - 1;
    let r = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_BTC, env.taker_required(), take_h(id, true, Some(REF)), 2);
    assert_eq!(r, vec![U128(0)]);
    let bet = c.get_bet(id).unwrap();
    assert_eq!(bet.tip_maker.0, 50_000, "1% of 5 USDC, in USDC");
    assert_eq!(bet.tip_taker.0, 100, "1% of 10_000 sats, in BTC");
    rule(&mut c, REF, id, "YES", 1_001);
    assert_eq!(sum_to(&c, id, REF, USDC), 50_000);
    assert_eq!(sum_to(&c, id, REF, MOCK_BTC), 100);
    // winner (maker) gets own-asset pots less fee less that side's tip
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 5_000_000 - 50_000 - 50_000);
    assert_eq!(sum_to(&c, id, "maker.testnet", MOCK_BTC), 10_000 - 100 - 100);
    assert_conserved(&c, id, &[(USDC, env.maker_required()), (MOCK_BTC, env.taker_required())]);
}

#[test]
fn rf2_tip_uses_the_bets_own_fee_copy_not_the_bps_alone() {
    // min fee 50_000 per side dominates 1% of 1_000_000 (10_000): tip = max(...) = 50_000.
    let mut assets = default_asset_limits();
    assets[0].1.min_per_side = U128(1_000_000);
    assets[0].1.min_fee_per_side = U128(50_000);
    let mut c = new_contract_with_limits_and_assets(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
        assets,
    );
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, true);
    let bet = c.get_bet(id).unwrap();
    assert_eq!((bet.fee_min_maker.0, bet.fee_min_taker.0), (50_000, 50_000));
    assert_eq!((bet.tip_maker.0, bet.tip_taker.0), (50_000, 50_000));
    rule(&mut c, REF, id, "YES", 1_001);
    assert_eq!(sum_to(&c, id, REF, USDC), 100_000);
    // maker: (1M - 50k fee - 50k tip) + (1M - 50k fee - 50k tip)
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_800_000);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_tip_without_a_referee_is_refused() {
    // maker opts in to a tip but names nobody
    let mut c = new_contract();
    let mut env = base_envelope("");
    env.tip_maker = true;
    let r = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(r, vec![U128(env.maker_required())], "tip with no referee: open refused");
    // taker opts in on an AI bet
    let env = base_envelope("");
    let id = open_h(&mut c, &env);
    let r = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_h(id, true, None), 2);
    assert_eq!(r, vec![U128(env.taker_required())], "tip on an AI bet: take refused");
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Open);
}

#[test]
fn rf2_concede_with_a_tip_pays_the_referee() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, true);
    ctx("taker.testnet", 1_500);
    c.concede(id); // taker concedes -> maker wins
    assert_eq!(sum_to(&c, id, REF, USDC), 20_000, "tip paid on concede");
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 1_960_000);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 0);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
    // the referee has nothing left to rule on
    ctx(REF, 1_501);
    assert!(fails(|| c.referee_rule(id, "NO".into())));
}

#[test]
fn rf2_deadline_void_with_a_tip_pays_referee_and_refunds_the_rest() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, true);
    ctx("anyone.testnet", 365 * DAY + 1);
    c.void_after_deadline(id);
    assert_eq!(sum_to(&c, id, REF, USDC), 20_000);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 990_000);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 990_000);
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_cancel_and_expire_before_take_refund_the_whole_deposit() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_h(&mut c, &env);
    ctx("maker.testnet", 5);
    c.cancel(id);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), DEP, "cancel: deposit back in full, tip included");
    assert_eq!(sum_to(&c, id, REF, USDC), 0, "no tip when never taken");
    assert_conserved(&c, id, &[(USDC, DEP)]);

    let id2 = open_h(&mut c, &env);
    ctx("anyone.testnet", 1_001);
    c.expire(id2);
    assert_eq!(sum_to(&c, id2, "maker.testnet", USDC), DEP);
    assert_eq!(sum_to(&c, id2, REF, USDC), 0);
    assert_conserved(&c, id2, &[(USDC, DEP)]);
}

// ------------------------------------------ halt path + invariant I-2

#[test]
fn rf2_emergency_shutdown_blocks_ruling_and_refunds_tips() {
    let mut c = new_contract();
    let mut env = h_env();
    env.tip_maker = true;
    let id = open_take(&mut c, &env, true);
    ctx_with_deposit(GUARDIAN, 1_100, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    ctx(REF, 1_200);
    assert!(fails(|| c.referee_rule(id, "YES".into())), "no ruling once the contract is halted");
    ctx("anyone.testnet", 365 * DAY + 5);
    assert!(fails(|| c.void_after_deadline(id)), "void_after_deadline is also blocked after shutdown");
    c.emergency_refund(id);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), DEP);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), DEP);
    assert_eq!(sum_to(&c, id, REF, USDC), 0, "tips refunded on emergency_refund, nothing to the referee");
    assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
}

#[test]
fn rf2_i2_balance_invariant_over_every_ending() {
    // Every ending of a fully tipped bet conserves deposits exactly.
    for ending in ["YES", "NO", "VOID", "concede_maker", "concede_taker", "deadline"] {
        let mut c = new_contract();
        let mut env = h_env();
        env.tip_maker = true;
        let id = open_take(&mut c, &env, true);
        match ending {
            "YES" | "NO" | "VOID" => rule(&mut c, REF, id, ending, 1_001),
            "concede_maker" => {
                ctx("maker.testnet", 1_001);
                c.concede(id);
            }
            "concede_taker" => {
                ctx("taker.testnet", 1_001);
                c.concede(id);
            }
            _ => {
                ctx("anyone.testnet", 365 * DAY + 1);
                c.void_after_deadline(id);
            }
        }
        assert_conserved(&c, id, &[(USDC, 2 * DEP)]);
        assert_eq!(sum_to(&c, id, REF, USDC), 20_000, "{ending}: referee earns both tips on every ending after the take");
        drain_all(&mut c, id, 2_000);
        assert!(c.is_fully_paid(id));
    }
}
