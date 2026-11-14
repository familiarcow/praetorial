//! Throwaway state-wipe (D-E2E1a). Testnet only; deployed over the item-8 escrow
//! account solely so DeleteAccount stops failing with DeleteAccountWithLargeState.
use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near};

#[near(contract_state)]
#[derive(Default)]
pub struct Wipe {}

#[near]
impl Wipe {
    /// Removes each given raw storage key. Self-call only. Returns number of keys that existed.
    pub fn wipe(keys: Vec<Base64VecU8>) -> u32 {
        // Static (no self): never deserializes the foreign escrow state sitting in storage.
        if env::predecessor_account_id() != env::current_account_id() {
            env::panic_str("only the account itself may wipe");
        }
        let mut removed = 0u32;
        for k in keys {
            if env::storage_remove(&k.0) {
                removed += 1;
            }
        }
        removed
    }
}
