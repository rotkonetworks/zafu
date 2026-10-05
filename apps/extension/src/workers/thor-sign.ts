/**
 * The liquidity page's thorchain account, inside the zcash worker. Its key
 * comes from one of three sources, recorded per pocket at the opt-in:
 *  - seed:   a hot wallet's phrase, m/44'/931'/0'/0/{index} (sealed vault in)
 *  - random: a key zafu made for a cold wallet, sealed like a seed (sealed box in)
 *  - fvk:    a cold wallet's viewing key, HKDF as in thorchain/derive.ts
 * The worker opens what it is given, makes the key, and either says the
 * address or signs one rune MsgDeposit and wipes the key. Broadcasting stays on the page, behind
 * its egress check: this file never talks to a network.
 *
 * Called only after the person chose "add with rune too" on lp.html; nothing
 * else in zafu sends these messages.
 */

import {
  deriveThorKey,
  deriveThorKeyFromFvk,
  isThorAddress,
  thorKeyFromHex,
  type ThorKey,
} from '@repo/wallet/networks/thorchain/derive';
import { buildSignedThorTx, runeDeposit } from '@repo/wallet/networks/thorchain/tx';

export type ThorKeySource = 'seed' | 'random' | 'fvk';

/**
 * The key for `source`: `secret` is the opened phrase (seed), the opened
 * hex (random) or the viewing key string (fvk).
 */
export const thorKeyOf = (source: ThorKeySource, secret: string, index: number): ThorKey => {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new Error('this rune address index is not valid');
  }
  return source === 'seed'
    ? deriveThorKey(secret, index)
    : source === 'random'
      ? thorKeyFromHex(secret)
      : deriveThorKeyFromFvk(secret, index);
};

export interface ThorDepositRequest {
  /** where the pocket's rune key comes from */
  source: ThorKeySource;
  /** fvk only: the viewing key string, exactly as stored */
  fvk?: string;
  /** the pocket's thorchain index */
  index: number;
  /** the address every read was made against: a different derivation refuses */
  expected: string;
  /** rune sent with the deposit, 1e8, decimal ("0" for a withdraw) */
  rune: string;
  memo: string;
  accountNumber: string;
  sequence: string;
}

/** a well-formed request, or the reason it isn't; checked before the phrase is opened */
export const checkThorRequest = (r: ThorDepositRequest): void => {
  if (!['seed', 'random', 'fvk'].includes(r.source) || (r.source === 'fvk' && !r.fvk)) {
    throw new Error('this rune key source is not valid');
  }
  if (!Number.isSafeInteger(r.index) || r.index < 1) {
    throw new Error('this rune address index is not valid');
  }
  if (!isThorAddress(r.expected)) {
    throw new Error('this rune address is not valid');
  }
  if (!/^\d+$/.test(r.rune) || !/^\d+$/.test(r.accountNumber) || !/^\d+$/.test(r.sequence)) {
    throw new Error('this rune deposit is not well formed');
  }
  if (!/^[+-]:ZEC\.ZEC(:[A-Za-z0-9.]+)*$/.test(r.memo) || r.memo.length > 250) {
    throw new Error('zafu signs only zec liquidity from this address');
  }
};

export const thorAddressFrom = (source: ThorKeySource, secret: string, index: number): string => {
  const k = thorKeyOf(source, secret, index);
  k.privateKey.fill(0);
  return k.address;
};

const toBase64 = (b: Uint8Array): string => {
  let bin = '';
  for (const x of b) {
    bin += String.fromCharCode(x);
  }
  return btoa(bin);
};

/** the signed TxRaw, base64; the key is wiped before this returns */
export const signThorDeposit = (secret: string, r: ThorDepositRequest): string => {
  checkThorRequest(r);
  const key = thorKeyOf(r.source, secret, r.index);
  try {
    if (key.address !== r.expected) {
      throw new Error('this rune address is not the one zafu read · nothing was signed');
    }
    return toBase64(
      buildSignedThorTx({
        msgs: [runeDeposit(key.address, BigInt(r.rune), r.memo)],
        memo: r.memo,
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        signer: key.address,
        accountNumber: BigInt(r.accountNumber),
        sequence: BigInt(r.sequence),
      }).txBytes,
    );
  } finally {
    key.privateKey.fill(0);
  }
};
