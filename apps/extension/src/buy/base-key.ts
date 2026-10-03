/**
 * The person's Base address: a burner inside the buy (and later sell) flow,
 * never a network. It is the Injective key (coin type 60, m/44'/60'/0'/0/0):
 * one secp256k1 key, the same 0x address on every EVM chain, derived by the
 * one function Injective already uses. No second derivation.
 *
 * Signing follows the existing hot path (hooks/cosmos-signer.ts): the page
 * asks the keyring for the selected wallet's mnemonic, derives, signs, and
 * zeroes the key. Nothing is stored.
 */

/*
 * NOT DONE YET - the recovery phrase is still opened in buy.html (review55
 * security #7), the realm that also loads @zkp2p/sdk, its attestation
 * client, ethers and viem. A compromised release of any of them could read
 * the phrase from this heap. What moving it out takes, worked out on
 * 2026-10-04 against this tree:
 *
 * 1. Worker ops, in the offscreen zcash worker that already opens sealed
 *    vaults for spends (getVaultUnlock -> sealFor -> withSpendKeys's vault
 *    open), so the page hands over a box it cannot read and the phrase
 *    never enters buy.html:
 *    - `base-address` {vault} -> the 0x address (no key leaves);
 *    - `base-sign-tx` {vault, unsignedTxHex, expect} -> the signed tx hex.
 *      The worker parses the unsigned tx (viem parseTransaction) and refuses
 *      unless chainId is 8453 and `to` is one of: Peer's EscrowV2 or its
 *      orchestrators (peer.ts ESCROW_V2 / ORCHESTRATORS: signalIntent,
 *      fulfillIntent, cancelIntent), or BASE_USDC with transfer() calldata
 *      whose recipient is the `expect.depositAddress` the page already
 *      validated (checkLeg) and whose amount is `expect.amount`. It derives
 *      m/44'/60'/0'/0/n, signs, zeroes the key, returns only the signature.
 * 2. buy.html: one viem `toAccount({ address, signTransaction })` whose
 *    signTransaction serializes the unsigned tx and asks the worker; it
 *    replaces every withBaseAccount (reserveNow, verify, swapOnce,
 *    cancelBuy). signMessage/signTypedData throw: in @zkp2p/sdk 0.14.5 typed
 *    data is signed only for referral codes (index.mjs signCreateReferralCode
 *    and its two siblings), which the buy never calls. Re-check on each sdk
 *    bump.
 * 3. freshShielded and baseAddressOf stop calling keyRing.getMnemonic: the
 *    shielded address comes from a vault-sealed derive op (this also fixes
 *    review55 security #6 for this caller, where `derive-address` carries
 *    the phrase over the extension message bus).
 * 4. Guards: add both ops to workers/seed-boundary.types.ts, and a source
 *    test that nothing under routes/buy or buy/ calls getMnemonic.
 * 5. Measure the worker bundle: viem's tx parse/serialize and secp256k1
 *    join it (the page keeps viem for reads either way).
 *
 * Which index `n` is (0, shared with Injective, or a fresh one per buy) is
 * a founder decision (review55 architecture #4) and is unchanged here.
 */

import { deriveEthWallet } from '@repo/wallet/networks/ethereum/derive';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';

/** account 0: the address Injective shows as 0x, so a person sees one EVM address */
const BASE_ACCOUNT = 0;

export const baseAddressOf = async (mnemonic: string): Promise<`0x${string}`> => {
  const w = await deriveEthWallet(mnemonic, BASE_ACCOUNT);
  w.privateKey.fill(0);
  return w.address as `0x${string}`;
};

/**
 * Run `fn` with a signing account for the Base key, then zero the key bytes.
 * viem keeps its own copy inside the account for the call's lifetime only.
 */
export const withBaseAccount = async <T>(
  mnemonic: string,
  fn: (account: PrivateKeyAccount) => Promise<T>,
): Promise<T> => {
  const w = await deriveEthWallet(mnemonic, BASE_ACCOUNT);
  try {
    const account = privateKeyToAccount(bytesToHex(w.privateKey));
    if (account.address.toLowerCase() !== w.address.toLowerCase()) {
      throw new Error('the base key did not match its address');
    }
    return await fn(account);
  } finally {
    w.privateKey.fill(0);
  }
};
