//! Minimal mock of `intents.near`'s multi-token ledger, for testnet E2E only.
//!
//! Real intents.near implements the full NEP-245 MultiTokenCore/
//! MultiTokenReceiver protocol plus signed-intent execution (ERC-191/
//! NEP-413/WebAuthn verification, `Transfer`+`NotifyOnTransfer` intents,
//! deposits from 1Click). None of that is reproduced here. This mock only
//! reimplements the two behaviours the escrow contract's tests/E2E actually
//! exercise:
//!   1. `mt_transfer` — a predecessor-authed balance move (used by escrow for
//!      payouts), matching the real contract's documented behaviour
//!      (predecessor's balance is debited, no signature needed because the
//!      caller already *is* the balance holder on intents.near).
//!   2. `transfer_with_msg` — stands in for a user signing a `Transfer`
//!      intent with a `NotifyOnTransfer.msg`; debits the caller, calls the
//!      receiver's `mt_on_transfer`, and (never-panic convention) credits
//!      back whatever the receiver's returned `Vec<U128>` says was rejected.
//!
//! `mint` is a test-only faucet (no real USDC bridging on testnet); it does
//! not exist on real intents.near.
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, PanicOnDefault, Promise, PromiseResult};

const NOTIFY_GAS: Gas = Gas::from_tgas(60);
const RESOLVE_GAS: Gas = Gas::from_tgas(15);
/// INTENTS1: real intents.near mt_resolve_gas(1 token) = 10 Tgas base + 5 Tgas per token.
const MT_RESOLVE_GAS: Gas = Gas::from_tgas(15);

fn key(account: &AccountId, token_id: &str) -> String {
    format!("{account}|{token_id}")
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockIntents {
    pub balances: LookupMap<String, u128>,
}

/// PRT-L2-029 test-only knob: a sentinel key inside the existing
/// `balances` map (value 1 = fail mode on), NOT a new struct field --
/// this contract is already deployed on testnet with real state, and a
/// borsh-schema change (new field) would break deserializing that state
/// on redeploy. Piggybacking on the existing map keeps the on-chain
/// upgrade state-compatible. When set, `mt_transfer` panics instead of
/// moving balance, so a caller (the escrow contract's `fire_payout`)
/// sees a genuinely FAILED promise -- not a manually forced `done=false`
/// row -- and must drive the real retry path. Does not exist on real
/// intents.near.
const FAIL_FLAG_KEY: &str = "__FAIL_MT_TRANSFER__";

/// Loop 6: the token id `near_deposit_and_credit` credits into, matching
/// escrow's `WNEAR_TOKEN_ID` constant exactly (must agree across both
/// contracts or a refund lands under a balance key nobody queries).
const WNEAR_TOKEN_ID: &str = "nep141:wrap.testnet";

#[ext_contract(ext_receiver)]
trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128>;
}

/// LIVE2 / WITHDRAW1: NEP-141 core, the calls `ft_withdraw` makes on the real token contract.
#[ext_contract(ext_ft)]
trait FungibleTokenCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
}

/// Gas for the token call, matching real intents.near's FtWithdraw::min_gas defaults (ft_transfer 15 Tgas,
/// ft_transfer_call 50 Tgas), and its FT_RESOLVE_WITHDRAW_GAS (15 Tgas).
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
const FT_TRANSFER_CALL_GAS: Gas = Gas::from_tgas(50);
const FT_RESOLVE_WITHDRAW_GAS: Gas = Gas::from_tgas(15);

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TransferOutcome {
    pub rejected: U128,
}

impl MockIntents {
    /// INTENTS1: real intents.near internal_mt_batch_transfer rules -- amount > 0 and sender != receiver
    /// ("invalid intent"), the sender must hold the amount.
    fn internal_move(&mut self, sender: &AccountId, receiver: &AccountId, token_id: &str, amount: u128) {
        if amount == 0 || sender == receiver {
            env::panic_str("invalid intent");
        }
        let from_key = key(sender, token_id);
        let bal = self.balances.get(&from_key).copied().unwrap_or(0);
        if bal < amount {
            env::panic_str("mock-intents: insufficient balance");
        }
        self.balances.insert(from_key, bal - amount);
        let to_key = key(receiver, token_id);
        let to_bal = self.balances.get(&to_key).copied().unwrap_or(0);
        self.balances.insert(to_key, to_bal + amount);
    }
}

#[near]
impl MockIntents {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(b"m"),
        }
    }

    /// Test-only. Toggles the PRT-L2-029 failure-injection knob (see
    /// `FAIL_FLAG_KEY` doc). Permissionless -- this is a disposable
    /// testnet mock, not a security boundary.
    pub fn set_fail_mt_transfer(&mut self, fail: bool) {
        self.balances
            .insert(FAIL_FLAG_KEY.to_string(), if fail { 1 } else { 0 });
    }

    pub fn fail_mt_transfer_enabled(&self) -> bool {
        self.balances.get(FAIL_FLAG_KEY).copied().unwrap_or(0) == 1
    }

    /// Test-only faucet. Real intents.near has no such method.
    pub fn mint(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        let k = key(&account_id, &token_id);
        let cur = self.balances.get(&k).copied().unwrap_or(0);
        self.balances.insert(k, cur + amount.0);
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(
            self.balances
                .get(&key(&account_id, &token_id))
                .copied()
                .unwrap_or(0),
        )
    }

    /// Loop 6 (FM-10): mock stand-in for the real two-step "wrap.near
    /// `near_deposit()` then `ft_transfer_call` to intents.near with a
    /// msg crediting `account_id`" flow escrow uses to refund unused
    /// OutLayer compute for an AuthCall-initiated run into the signer's
    /// intents wNEAR balance (never a native transfer for that path).
    /// This mock plays both wrap.near's and intents.near's role in one
    /// call since it's a disposable testnet mock, not a security
    /// boundary -- the real deployment issues the two real calls against
    /// real `wrap.near`/`intents.near`. Permissionless like `mint`: any
    /// caller may credit any account, same trust level as the existing
    /// test faucet.
    #[payable]
    pub fn near_deposit_and_credit(&mut self, account_id: AccountId) {
        let amount = env::attached_deposit().as_yoctonear();
        let k = key(&account_id, WNEAR_TOKEN_ID);
        let bal = self.balances.get(&k).copied().unwrap_or(0);
        self.balances.insert(k, bal + amount);
    }

    /// RELAYFUND2: NEP-141 `ft_on_transfer` receiver, so `ft_transfer_call(intents, amount, msg)` on a token contract
    /// credits the multi-token ledger instead of failing MethodNotFound and refunding. The token is the predecessor
    /// (the token contract) as `nep141:<predecessor>`; msg `{"receiver_id": "..."}` selects the credited account,
    /// otherwise `sender_id`. Returns "0" unused (the whole amount is kept). Adds a method only: no state change.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        // INTENTS1: exactly real intents.near's DepositMessage::from_str (contracts/defuse/src/tokens/mod.rs +
        // tokens/nep141/deposit.rs): amount > 0; empty msg -> sender; '{'-prefixed -> JSON whose receiver_id is
        // REQUIRED; otherwise the msg must itself be an AccountId. A bad msg panics (the token then refunds the sender).
        #[derive(Deserialize)]
        #[serde(crate = "near_sdk::serde")]
        struct Msg {
            receiver_id: AccountId,
        }
        if amount.0 == 0 {
            env::panic_str("zero amount");
        }
        let to: AccountId = if msg.is_empty() {
            sender_id
        } else if msg.starts_with('{') {
            near_sdk::serde_json::from_str::<Msg>(&msg)
                .unwrap_or_else(|e| env::panic_str(&format!("JSON: {e}")))
                .receiver_id
        } else {
            msg.parse().unwrap_or_else(|e| env::panic_str(&format!("{e}")))
        };
        let k = key(&to, &format!("nep141:{}", env::predecessor_account_id()));
        let cur = self.balances.get(&k).copied().unwrap_or(0);
        self.balances.insert(k, cur + amount.0);
        U128(0)
    }

    /// LIVE2 / WITHDRAW1: mirrors real intents.near `ft_withdraw(token, receiver_id, amount, memo, msg)`
    /// (near/intents contracts/defuse/src/contract/tokens/nep141/withdraw.rs): exactly 1 yocto, the PREDECESSOR's
    /// `nep141:<token>` balance is debited (panics if short), then the real token is `ft_transfer`red to `receiver_id`
    /// (`ft_transfer_call` when `msg` is set) and `ft_resolve_withdraw` refunds the ledger if that failed. wNEAR stays
    /// wNEAR (no unwrap), like the real contract. The mock must hold the real tokens it pays out. Method-only addition:
    /// no state layout change.
    #[payable]
    pub fn ft_withdraw(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: Option<String>,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        if amount.0 == 0 {
            env::panic_str("mock-intents: amount must be > 0");
        }
        let owner = env::predecessor_account_id();
        let k = key(&owner, &format!("nep141:{token}"));
        let bal = self.balances.get(&k).copied().unwrap_or(0);
        if bal < amount.0 {
            env::panic_str("mock-intents: insufficient balance");
        }
        self.balances.insert(k, bal - amount.0);
        let is_call = msg.is_some();
        let one = near_sdk::NearToken::from_yoctonear(1);
        let transfer = match msg {
            Some(m) => ext_ft::ext(token.clone()).with_attached_deposit(one).with_static_gas(FT_TRANSFER_CALL_GAS).ft_transfer_call(receiver_id, amount, memo, m),
            None => ext_ft::ext(token.clone()).with_attached_deposit(one).with_static_gas(FT_TRANSFER_GAS).ft_transfer(receiver_id, amount, memo),
        };
        transfer.then(
            Self::ext(env::current_account_id())
                .with_static_gas(FT_RESOLVE_WITHDRAW_GAS)
                .with_unused_gas_weight(0)
                .ft_resolve_withdraw(token, owner, amount, is_call),
        )
    }

    /// Same semantics as real intents.near `ft_resolve_withdraw`: returns the amount actually withdrawn and credits the
    /// rest back. A failed plain `ft_transfer` is refunded in full; a failed `ft_transfer_call` is NOT refunded (the real
    /// contract's NEP-141 resolve-gas caveat); a successful call refunds whatever the receiver did not use.
    #[private]
    pub fn ft_resolve_withdraw(&mut self, token: AccountId, sender_id: AccountId, amount: U128, is_call: bool) -> U128 {
        let used = if is_call {
            match env::promise_result(0) {
                PromiseResult::Successful(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes).map(|u| u.0.min(amount.0)).unwrap_or(0),
                PromiseResult::Failed => amount.0,
            }
        } else {
            match env::promise_result(0) {
                PromiseResult::Successful(_) => amount.0,
                PromiseResult::Failed => 0,
            }
        };
        let refund = amount.0.saturating_sub(used);
        if refund > 0 {
            let k = key(&sender_id, &format!("nep141:{token}"));
            let cur = self.balances.get(&k).copied().unwrap_or(0);
            self.balances.insert(k, cur + refund);
            env::log_str(&format!("mock-intents: ft_withdraw refund {refund} {token} to {sender_id}"));
        }
        U128(used)
    }

    /// Predecessor-authed transfer (mirrors real intents.near: whoever calls
    /// is debited, no signature check here because the predecessor already
    /// *is* the authenticated balance holder per NEAR runtime semantics).
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        #[allow(unused_variables)] memo: Option<String>,
    ) {
        // PRT-L2-029: injected failure, fires BEFORE any balance mutation
        // -- mirrors a real intents.near `mt_transfer` promise that fails
        // outright (e.g. receiver paused/rejects/network issue), so the
        // escrow side sees `PromiseResult::Failed` in `on_payout_result`
        // and no money moves anywhere on this failed attempt.
        if self.fail_mt_transfer_enabled() {
            env::panic_str("mock-intents: injected failure (PRT-L2-029 test)");
        }
        // INTENTS1: real intents.near mt_batch_transfer: assert_one_yocto, no approvals, amount > 0, sender != receiver.
        near_sdk::assert_one_yocto();
        if approval.is_some() {
            env::panic_str("approvals are not supported");
        }
        let sender = env::predecessor_account_id();
        self.internal_move(&sender, &receiver_id, &token_id, amount.0);
    }

    /// INTENTS1: real intents.near NEP-245 `mt_transfer_call` (contracts/defuse/src/contract/tokens/nep245/core.rs):
    /// 1 yocto, no approvals, moves the predecessor's balance to `receiver_id`, then calls
    /// `receiver_id.mt_on_transfer(sender_id, previous_owner_ids=[sender_id], token_ids, amounts, msg)` with ALL the
    /// remaining gas (static 0, weight 1) and `mt_resolve_transfer` (15 Tgas reserved) refunds whatever it returns.
    /// This is the call open/take/bond use; `transfer_with_msg` below is the legacy mock-only shape.
    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        #[allow(unused_variables)] memo: Option<String>,
        msg: String,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        if approval.is_some() {
            env::panic_str("approvals are not supported");
        }
        let sender = env::predecessor_account_id();
        self.internal_move(&sender, &receiver_id, &token_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_gas(0))
            .with_unused_gas_weight(1)
            .mt_on_transfer(sender.clone(), vec![sender.clone()], vec![token_id.clone()], vec![amount], msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(MT_RESOLVE_GAS)
                    .with_unused_gas_weight(0)
                    .mt_resolve_transfer(vec![sender], receiver_id, vec![token_id], vec![amount], None),
            )
    }

    /// INTENTS1: real `mt_resolve_transfer` (nep245/resolver.rs): the refund is what `mt_on_transfer` returned (a
    /// failed/garbled result = refund everything), capped per token at the amount and at the receiver's current
    /// balance; returns the amounts actually kept by the receiver.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        previous_owner_ids: Vec<AccountId>,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Vec<(AccountId, u64)>>>>,
    ) -> Vec<U128> {
        if approvals.is_some() {
            env::panic_str("approvals are not supported");
        }
        if token_ids.is_empty() || previous_owner_ids.len() != token_ids.len() || amounts.len() != token_ids.len() {
            env::panic_str("invalid args");
        }
        let refunds: Vec<U128> = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => near_sdk::serde_json::from_slice::<Vec<U128>>(&bytes)
                .ok()
                .filter(|r| r.len() == amounts.len())
                .unwrap_or_else(|| amounts.clone()),
            PromiseResult::Failed => amounts.clone(),
        };
        let mut used = amounts.clone();
        for i in 0..token_ids.len() {
            let recv_key = key(&receiver_id, &token_ids[i]);
            let recv_bal = self.balances.get(&recv_key).copied().unwrap_or(0);
            let refund = refunds[i].0.min(amounts[i].0).min(recv_bal);
            if refund == 0 {
                continue;
            }
            self.balances.insert(recv_key, recv_bal - refund);
            let back = key(&previous_owner_ids[i], &token_ids[i]);
            let cur = self.balances.get(&back).copied().unwrap_or(0);
            self.balances.insert(back, cur + refund);
            used[i] = U128(amounts[i].0 - refund);
        }
        used
    }

    /// INTENTS1: real NEP-245 `mt_batch_balance_of` (the treasury reads balances with it).
    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect()
    }

    /// Stands in for a user signing an intents `Transfer{receiver_id,
    /// tokens, msg}` intent. Debits the caller immediately, then notifies
    /// the receiver; whatever the receiver's `mt_on_transfer` returns as
    /// "rejected" is credited back to the caller (never-panic/full-or-nothing
    /// refund convention, matching the real NEP-245 resolve semantics).
    pub fn transfer_with_msg(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        msg: String,
    ) -> Promise {
        let sender = env::predecessor_account_id();
        let from_key = key(&sender, &token_id);
        let bal = self.balances.get(&from_key).copied().unwrap_or(0);
        if bal < amount.0 {
            env::panic_str("mock-intents: insufficient balance");
        }
        self.balances.insert(from_key, bal - amount.0);
        let to_key = key(&receiver_id, &token_id);
        let to_bal = self.balances.get(&to_key).copied().unwrap_or(0);
        self.balances.insert(to_key, to_bal + amount.0);

        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(NOTIFY_GAS)
            .mt_on_transfer(
                sender.clone(),
                vec![sender.clone()],
                vec![token_id.clone()],
                vec![amount],
                msg,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RESOLVE_GAS)
                    .resolve_transfer(sender, receiver_id, token_id, amount),
            )
    }

    #[private]
    pub fn resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
    ) -> U128 {
        let rejected: u128 = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => {
                near_sdk::serde_json::from_slice::<Vec<U128>>(&bytes)
                    .ok()
                    .and_then(|v| v.first().copied())
                    .map(|u| u.0)
                    .unwrap_or(amount.0) // malformed response: assume full reject (never trust 0 by default)
            }
            PromiseResult::Failed => amount.0, // receiver panicked/failed: full refund
        };
        let rejected = rejected.min(amount.0);
        if rejected > 0 {
            let recv_key = key(&receiver_id, &token_id);
            let recv_bal = self.balances.get(&recv_key).copied().unwrap_or(0);
            self.balances
                .insert(recv_key, recv_bal.saturating_sub(rejected));
            let sender_key = key(&sender_id, &token_id);
            let sender_bal = self.balances.get(&sender_key).copied().unwrap_or(0);
            self.balances.insert(sender_key, sender_bal + rejected);
        }
        U128(amount.0 - rejected)
    }
}

#[cfg(test)]
mod ft_on_transfer_tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn as_predecessor(p: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acct(p)).build());
    }
    fn fresh() -> MockIntents {
        testing_env!(VMContextBuilder::new().build());
        MockIntents::new()
    }

    #[test]
    fn credits_receiver_from_json_msg_by_predecessor_token_and_returns_zero() {
        let mut c = fresh();
        as_predecessor("wrap.testnet");
        let r = c.ft_on_transfer(acct("sender.testnet"), U128(500), r#"{"receiver_id":"abc.testnet"}"#.into());
        assert_eq!(r, U128(0));
        assert_eq!(c.mt_balance_of(acct("abc.testnet"), "nep141:wrap.testnet".into()), U128(500));
        assert_eq!(c.mt_balance_of(acct("sender.testnet"), "nep141:wrap.testnet".into()), U128(0));
    }

    // INTENTS1: real intents.near DepositMessage::from_str (contracts/defuse/src/tokens/mod.rs): empty msg -> sender;
    // '{'-prefixed -> JSON that MUST carry receiver_id; anything else MUST be a bare AccountId. A bad msg PANICS (the
    // token contract's ft_resolve_transfer then refunds the sender); it is never silently credited to the sender. This
    // replaces a test that pinned the old mock's divergent "bad msg -> credit sender" behaviour.
    #[test]
    fn credits_sender_when_msg_empty() {
        let mut c = fresh();
        as_predecessor("wrap.testnet");
        assert_eq!(c.ft_on_transfer(acct("s.testnet"), U128(7), "".into()), U128(0));
        assert_eq!(c.mt_balance_of(acct("s.testnet"), "nep141:wrap.testnet".into()), U128(7));
    }

    #[test]
    fn credits_a_bare_account_id_msg() {
        let mut c = fresh();
        as_predecessor("wrap.testnet");
        assert_eq!(c.ft_on_transfer(acct("s.testnet"), U128(4), "abc.testnet".into()), U128(0));
        assert_eq!(c.mt_balance_of(acct("abc.testnet"), "nep141:wrap.testnet".into()), U128(4));
        assert_eq!(c.mt_balance_of(acct("s.testnet"), "nep141:wrap.testnet".into()), U128(0));
    }

    #[test]
    #[should_panic]
    fn json_msg_without_receiver_panics() {
        let mut c = fresh();
        as_predecessor("wrap.testnet");
        c.ft_on_transfer(acct("s.testnet"), U128(3), "{}".into());
    }

    #[test]
    #[should_panic]
    fn non_account_non_json_msg_panics() {
        let mut c = fresh();
        as_predecessor("wrap.testnet");
        c.ft_on_transfer(acct("s.testnet"), U128(1), "not json".into());
    }

    #[test]
    #[should_panic(expected = "zero amount")]
    fn zero_amount_panics() {
        let mut c = fresh();
        as_predecessor("wrap.testnet");
        c.ft_on_transfer(acct("s.testnet"), U128(0), "".into());
    }

    #[test]
    fn accumulates_and_keys_by_token_contract() {
        let mut c = fresh();
        as_predecessor("wrap.testnet");
        c.ft_on_transfer(acct("s.testnet"), U128(5), "".into());
        c.ft_on_transfer(acct("s.testnet"), U128(5), "".into());
        as_predecessor("usdc.fakes.testnet");
        c.ft_on_transfer(acct("s.testnet"), U128(9), "".into());
        assert_eq!(c.mt_balance_of(acct("s.testnet"), "nep141:wrap.testnet".into()), U128(10));
        assert_eq!(c.mt_balance_of(acct("s.testnet"), "nep141:usdc.fakes.testnet".into()), U128(9));
    }

    #[test]
    fn state_layout_unchanged_existing_methods_still_work() {
        let mut c = fresh();
        c.mint(acct("a.testnet"), "t".into(), U128(4));
        assert_eq!(c.mt_balance_of(acct("a.testnet"), "t".into()), U128(4));
    }
}

/// LIVE2 / WITHDRAW1: `ft_withdraw` mirrors real intents.near (near/intents contracts/defuse/src/contract/tokens/nep141/withdraw.rs):
/// 1 yocto, the predecessor's `nep141:<token>` balance is debited, the real token is `ft_transfer`red (or `ft_transfer_call`ed
/// when `msg` is set) to `receiver_id`, and `ft_resolve_withdraw` refunds the ledger if the transfer failed.
#[cfg(test)]
mod ft_withdraw_tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken, RuntimeFeesConfig};

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(pred: &str, yocto: u128) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id(acct("intents-mock.testnet"))
            .predecessor_account_id(acct(pred))
            .attached_deposit(NearToken::from_yoctonear(yocto))
            .build()
    }
    fn funded() -> MockIntents {
        testing_env!(ctx("intents-mock.testnet", 0));
        let mut c = MockIntents::new();
        c.mint(acct("alice.testnet"), "nep141:wrap.testnet".into(), U128(1_000));
        c
    }
    fn bal(c: &MockIntents, a: &str) -> u128 {
        c.mt_balance_of(acct(a), "nep141:wrap.testnet".into()).0
    }
    fn resolve_with(c: &mut MockIntents, r: PromiseResult, amount: u128, is_call: bool) -> U128 {
        testing_env!(ctx("intents-mock.testnet", 0), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]);
        c.ft_resolve_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(amount), is_call)
    }

    #[test]
    fn debits_the_signer_by_exactly_the_amount() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(400), None, None);
        assert_eq!(bal(&c, "alice.testnet"), 600);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn requires_exactly_one_yocto() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 0));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(1), None, None);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn refuses_more_than_the_balance() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(1_001), None, None);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn cannot_withdraw_someone_elses_balance() {
        let mut c = funded();
        testing_env!(ctx("mallory.testnet", 1));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("mallory.testnet"), U128(1), None, None);
    }

    #[test]
    fn resolve_keeps_the_debit_when_ft_transfer_succeeded() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(400), None, None);
        assert_eq!(resolve_with(&mut c, PromiseResult::Successful(vec![]), 400, false), U128(400));
        assert_eq!(bal(&c, "alice.testnet"), 600);
    }

    #[test]
    fn resolve_refunds_the_ledger_when_ft_transfer_failed() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(400), None, None);
        assert_eq!(resolve_with(&mut c, PromiseResult::Failed, 400, false), U128(0));
        assert_eq!(bal(&c, "alice.testnet"), 1_000);
    }

    #[test]
    fn resolve_for_a_call_refunds_the_unused_part_and_never_refunds_on_failure() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(400), None, Some("m".into()));
        assert_eq!(resolve_with(&mut c, PromiseResult::Successful(b"\"150\"".to_vec()), 400, true), U128(150));
        assert_eq!(bal(&c, "alice.testnet"), 850);
        // real intents.near: a failed ft_transfer_call is NOT refunded (NEP-141 resolve-gas vulnerability)
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.ft_withdraw(acct("wrap.testnet"), acct("alice.testnet"), U128(400), None, Some("m".into()));
        assert_eq!(resolve_with(&mut c, PromiseResult::Failed, 400, true), U128(400));
        assert_eq!(bal(&c, "alice.testnet"), 600);
    }
}

/// INTENTS1: the NEP-245 surface the escrow and the web use, mirroring real intents.near
/// (near/intents rev 16d04f6e contracts/defuse/src/contract/tokens/nep245/{core,resolver}.rs; fixtures/intents_near/real_abi.json).
#[cfg(test)]
mod nep245_real_shape_tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{testing_env, NearToken, RuntimeFeesConfig};

    const W: &str = "nep141:wrap.testnet";
    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(pred: &str, yocto: u128) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id(acct("intents-mock.testnet"))
            .predecessor_account_id(acct(pred))
            .attached_deposit(NearToken::from_yoctonear(yocto))
            .prepaid_gas(Gas::from_tgas(150))
            .build()
    }
    fn funded() -> MockIntents {
        testing_env!(ctx("intents-mock.testnet", 0));
        let mut c = MockIntents::new();
        c.mint(acct("alice.testnet"), W.into(), U128(1_000));
        c
    }
    fn bal(c: &MockIntents, a: &str) -> u128 {
        c.mt_balance_of(acct(a), W.into()).0
    }

    #[test]
    fn mt_transfer_call_moves_the_balance_and_notifies_mt_on_transfer_with_the_real_args() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.mt_transfer_call(acct("escrow.testnet"), W.into(), U128(400), None, None, "{\"kind\":\"Take\"}".into());
        assert_eq!(bal(&c, "alice.testnet"), 600);
        assert_eq!(bal(&c, "escrow.testnet"), 400);
        let receipts = get_created_receipts();
        let notify = receipts.iter().find(|r| r.receiver_id == acct("escrow.testnet")).expect("mt_on_transfer receipt");
        let fc = notify.actions.iter().find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => Some((method_name.clone(), args.clone(), *attached_deposit)),
            _ => None,
        }).expect("function call");
        assert_eq!(String::from_utf8(fc.0).unwrap(), "mt_on_transfer");
        assert_eq!(fc.2, NearToken::from_yoctonear(0));
        let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&fc.1).unwrap();
        assert_eq!(v, near_sdk::serde_json::json!({
            "sender_id": "alice.testnet", "previous_owner_ids": ["alice.testnet"], "token_ids": [W], "amounts": ["400"], "msg": "{\"kind\":\"Take\"}"
        }));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn mt_transfer_call_requires_one_yocto() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 0));
        let _ = c.mt_transfer_call(acct("escrow.testnet"), W.into(), U128(1), None, None, "".into());
    }

    #[test]
    #[should_panic(expected = "approvals are not supported")]
    fn mt_transfer_call_refuses_approvals() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.mt_transfer_call(acct("escrow.testnet"), W.into(), U128(1), Some((acct("bob.testnet"), 1)), None, "".into());
    }

    #[test]
    #[should_panic(expected = "invalid intent")]
    fn mt_transfer_call_refuses_zero_amount() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.mt_transfer_call(acct("escrow.testnet"), W.into(), U128(0), None, None, "".into());
    }

    #[test]
    #[should_panic(expected = "invalid intent")]
    fn mt_transfer_call_refuses_self_transfer() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.mt_transfer_call(acct("alice.testnet"), W.into(), U128(1), None, None, "".into());
    }

    #[test]
    fn mt_resolve_transfer_refunds_what_the_receiver_returned_capped_at_its_balance() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.mt_transfer_call(acct("escrow.testnet"), W.into(), U128(400), None, None, "".into());
        // receiver rejected everything (escrow's I-3 full refund returns `amounts`)
        testing_env!(ctx("intents-mock.testnet", 0), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(),
            vec![PromiseResult::Successful(b"[\"400\"]".to_vec())]);
        let used = c.mt_resolve_transfer(vec![acct("alice.testnet")], acct("escrow.testnet"), vec![W.into()], vec![U128(400)], None);
        assert_eq!(used, vec![U128(0)]);
        assert_eq!(bal(&c, "alice.testnet"), 1_000);
        assert_eq!(bal(&c, "escrow.testnet"), 0);
        // accepted (escrow returns [0]) -> nothing refunded
        testing_env!(ctx("alice.testnet", 1));
        let _ = c.mt_transfer_call(acct("escrow.testnet"), W.into(), U128(300), None, None, "".into());
        testing_env!(ctx("intents-mock.testnet", 0), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(),
            vec![PromiseResult::Successful(b"[\"0\"]".to_vec())]);
        assert_eq!(c.mt_resolve_transfer(vec![acct("alice.testnet")], acct("escrow.testnet"), vec![W.into()], vec![U128(300)], None), vec![U128(300)]);
        assert_eq!(bal(&c, "alice.testnet"), 700);
        assert_eq!(bal(&c, "escrow.testnet"), 300);
        // receiver failed -> full refund, but never more than the receiver still holds (real resolver caps it)
        testing_env!(ctx("intents-mock.testnet", 0), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
        assert_eq!(c.mt_resolve_transfer(vec![acct("alice.testnet")], acct("escrow.testnet"), vec![W.into()], vec![U128(500)], None), vec![U128(200)]);
        assert_eq!(bal(&c, "escrow.testnet"), 0);
        assert_eq!(bal(&c, "alice.testnet"), 1_000);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn mt_transfer_requires_one_yocto() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 0));
        c.mt_transfer(acct("bob.testnet"), W.into(), U128(1), None, None);
    }

    #[test]
    #[should_panic(expected = "invalid intent")]
    fn mt_transfer_refuses_zero_amount() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        c.mt_transfer(acct("bob.testnet"), W.into(), U128(0), None, None);
    }

    #[test]
    fn mt_transfer_with_one_yocto_moves_the_balance() {
        let mut c = funded();
        testing_env!(ctx("alice.testnet", 1));
        c.mt_transfer(acct("bob.testnet"), W.into(), U128(250), None, None);
        assert_eq!(bal(&c, "alice.testnet"), 750);
        assert_eq!(bal(&c, "bob.testnet"), 250);
    }

    #[test]
    fn mt_batch_balance_of_returns_balances_in_request_order() {
        let c = funded();
        assert_eq!(c.mt_batch_balance_of(acct("alice.testnet"), vec!["nep141:usdc.testnet".into(), W.into()]), vec![U128(0), U128(1_000)]);
    }
}
