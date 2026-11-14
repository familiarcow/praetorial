// INTENTS1: the ONE builder for a stake/bond/objection deposit into the escrow (open, take, challenge). Real
// intents.near (NEP-245, near/intents rev 16d04f6e contracts/defuse/src/contract/tokens/nep245/core.rs; pinned in
// fixtures/intents_near/real_abi.json) moves an intents balance to a contract with a notification via
// `mt_transfer_call(receiver_id, token_id, amount, approval?, memo?, msg)` and REQUIRES exactly 1 yoctoNEAR. It then
// calls escrow.mt_on_transfer(sender_id, [sender_id], [token_id], [amount], msg) with the remaining gas and refunds what
// the escrow returns. mock-intents mirrors it on testnet. (The old mock-only `transfer_with_msg` is MethodNotFound on
// intents.near.)
import { ESCROW_CONTRACT_ID, INTENTS_CONTRACT_ID } from "./config";
import { gasForMethod } from "./relayGas";

export const STAKE_TRANSFER_METHOD = "mt_transfer_call" as const;

export interface StakeTransferCall {
  receiverId: string;
  methodName: typeof STAKE_TRANSFER_METHOD;
  args: { receiver_id: string; token_id: string; amount: string; msg: string };
  depositYocto: "1";
  gasTgas: number;
}

export function buildStakeTransfer(p: { tokenId: string; amount: string; msg: string; escrow?: string; intents?: string }): StakeTransferCall {
  const amount = String(p.amount);
  if (!/^\d+$/.test(amount) || BigInt(amount) === 0n) throw new Error("stake amount must be a positive whole number of base units");
  if (!/^nep(141|171|245):\S+$/.test(String(p.tokenId))) throw new Error(`stake token id must be an intents token id (nep141:...), got ${p.tokenId}`);
  if (typeof p.msg !== "string") throw new Error("stake msg must be a string");
  return {
    receiverId: p.intents ?? INTENTS_CONTRACT_ID,
    methodName: STAKE_TRANSFER_METHOD,
    args: { receiver_id: p.escrow ?? ESCROW_CONTRACT_ID, token_id: p.tokenId, amount, msg: p.msg },
    depositYocto: "1",
    gasTgas: gasForMethod(STAKE_TRANSFER_METHOD),
  };
}
