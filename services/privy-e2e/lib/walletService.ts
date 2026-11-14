// Step (a): idempotent per-user NEAR wallet provisioning.
//
// ARCHITECTURE DECISION (familiarcow, 2026-11-03): Option 1 -- wallets are
// USER-OWNED, with no app authorization key and no additional signers.
// The server never signs on a user's behalf; it only ever builds and
// broadcasts a tx whose signature the CLIENT produced (live user
// session). getOrCreateUserWallet() below therefore creates wallets
// the Option-1 way: inline via POST /v1/users {wallets:[{chain_type:
// 'near'}]}, which Privy returns with owner_id = a per-user
// authorization key and entity.type:'user' -- i.e. genuinely
// non-custodial, exactly per docs.privy.io/controls/authorization-keys/
// owners/configuration/user ("Creating wallets with a user owner").
//
// CONFIRMED LIVE (see Wallet layer v1.md §1): raw_sign against a
// user-owned wallet with ONLY the app secret fails with
// "No valid authorization keys or user signing keys available"
// (no_valid_user_session_keys) -- this is the correct, by-design
// behavior for Option 1, not a bug. It means our server genuinely
// cannot move a user's funds without that user's live session; see
// lib/signAndSend.ts's doc for the client-side signing shape this
// implies in production.
//
// A SEPARATE, test-harness-only path (createWallet() with no owner
// at all -- owner_id:null, entity:null) was used earlier in this
// session purely to exercise the build/sign/broadcast/verify
// MECHANICS end-to-end with a real Privy raw_sign call (since a
// user-owned wallet can't be signed server-side at all). That path is
// NOT what ships -- see scripts/05_signer_service_tests.ts's doc and
// the wallet layer doc's gaps list.
import { createUser, createUserWithNearWallet, createWallet, getUser } from "./privy.js";
import { findByEmail, createIfAbsent, WalletRow } from "./walletStore.js";
import { implicitAccountIdFromPublicKeyHex } from "./nearRaw.js";

export interface GetOrCreateResult {
  row: WalletRow;
  created: boolean; // false means an existing row was returned (idempotent hit)
}

/** Idempotent: if `email` already has a row in the local store, returns
 * it unchanged (created:false) without calling Privy at all. Only
 * creates a new Privy user + wallet when no local row exists. */
export async function getOrCreateUserWallet(email: string): Promise<GetOrCreateResult> {
  const existing = findByEmail(email);
  if (existing) {
    return { row: existing, created: false };
  }

  // Option 1: user + wallet created together, wallet comes back
  // owner_id = a per-user authorization key (NOT our app secret,
  // NOT any additional signer) -- genuinely user-owned.
  const user = await createUserWithNearWallet(email);

  const nearWallet = (user.linked_accounts ?? []).find((a: any) => a.type === "wallet" && a.chain_type === "near");
  if (!nearWallet) throw new Error(`createUserWithNearWallet returned no near wallet for ${email}: ${JSON.stringify(user)}`);
  const publicKeyHex: string = nearWallet.address;
  const walletId: string = nearWallet.id;
  const implicitAccountId = implicitAccountIdFromPublicKeyHex(publicKeyHex);

  const row: WalletRow = {
    privyUserId: user.id,
    email,
    walletId,
    publicKeyHex,
    implicitAccountId,
    createdAt: new Date().toISOString(),
  };
  // Atomic create-if-absent at the DB layer: if two callers raced on
  // the same brand-new email and both reach here after awaiting
  // createUserWithNearWallet, the UNIQUE index on privy_user_id lets
  // exactly one INSERT win; the other gets back the winner's row
  // instead of a duplicate wallet.
  return createIfAbsent(row);
}
