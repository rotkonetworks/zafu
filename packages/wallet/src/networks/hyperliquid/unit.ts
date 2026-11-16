/**
 * Unit (hyperunit): native ZEC in and out of Hyperliquid's spot token UZEC.
 * Unit's guardians generate one permanent address per destination; zafu pays
 * or shows one only after two of the three guardians' signatures over it
 * verify against the keys pinned here. Plain functions, injectable fetch.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes } from '@noble/hashes/utils';
import { toChecksumAddress } from '../ethereum/derive';
import { UNIT_API } from './api';

type FetchFn = typeof fetch;

/**
 * Mainnet guardian keys (P-256, uncompressed), copied 2026-11-16 from
 * https://docs.hyperunit.xyz/developers/key-addresses/mainnet . The same
 * three are in the docs' own verification code
 * (developers/api/generate-address/guardian-signatures). Never fetched.
 */
const GUARDIANS: Record<string, string> = {
  'unit-node':
    '04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061',
  'hl-node':
    '048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b',
  'field-node':
    '04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99',
};
/** the docs: "at least two distinct guardians" */
const THRESHOLD = 2;

const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/**
 * How many pinned guardians signed `message` (ECDSA P-256 over SHA-256, a
 * raw 64-byte r||s in base64). The message is the docs' current payload,
 * `<node>:user-<coin type>-<destination chain>-<destination>-<address>`.
 */
export const guardiansSigned = (
  signatures: unknown,
  message: (nodeId: string) => string,
): number => {
  const given = (signatures ?? {}) as Record<string, unknown>;
  return Object.entries(GUARDIANS).filter(([node, key]) => {
    const sig = given[node];
    try {
      const bytes = typeof sig === 'string' ? fromBase64(sig) : new Uint8Array();
      return (
        bytes.length === 64 &&
        // lowS off: the docs verify with WebCrypto, which takes either s
        p256.verify(bytes, sha256(new TextEncoder().encode(message(node))), hexToBytes(key), {
          lowS: false,
        })
      );
    } catch {
      return false;
    }
  }).length;
};

const generate = async (path: string, fetchFn: FetchFn) => {
  const res = await fetchFn(`${UNIT_API}/gen/${path}`);
  if (!res.ok) {
    throw new Error(`unit did not give an address: ${res.status}`);
  }
  return (await res.json()) as { address?: unknown; signatures?: unknown };
};

const refuse = (): never => {
  throw new Error("unit's guardians did not sign this address, so zafu will not use it");
};

/**
 * The address that credits ZEC to `account` on Hyperliquid: a ZIP 320 tex
 * address, paid from transparent funds only. The guardians sign its base58
 * twin (same key hash), so the caller's `base58Of` gives that form.
 */
export async function unitDepositAddress(
  account: string,
  base58Of: (tex: string) => Promise<string>,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const { address, signatures } = await generate(`zcash/hyperliquid/zec/${account}`, fetchFn);
  if (typeof address !== 'string' || !/^tex1[02-9ac-hj-np-z]{38}$/.test(address)) {
    return refuse();
  }
  const signed = await base58Of(address);
  const dst = toChecksumAddress(account);
  return guardiansSigned(signatures, n => `${n}:user-zcash-hyperliquid-${dst}-${signed}`) >=
    THRESHOLD
    ? address
    : refuse();
}

/**
 * The Hyperliquid address that, sent UZEC, pays ZEC out to the transparent
 * address `zcashT` (base58).
 */
export async function unitWithdrawAddress(
  zcashT: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const { address, signatures } = await generate(`hyperliquid/zcash/zec/${zcashT}`, fetchFn);
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return refuse();
  }
  return guardiansSigned(signatures, n => `${n}:user-ethereum-zcash-${zcashT}-${address}`) >=
    THRESHOLD
    ? address
    : refuse();
}

/** Unit's own estimate of what each way costs and takes, as its api says it now */
export interface UnitZecEstimate {
  depositFeeZat: bigint;
  depositEta: string;
  withdrawFeeZat: bigint;
  withdrawEta: string;
}

export async function unitZecEstimate(fetchFn: FetchFn = fetch): Promise<UnitZecEstimate> {
  const res = await fetchFn(`${UNIT_API}/v2/estimate-fees`);
  const z = res.ok ? ((await res.json()) as { zcash?: Record<string, unknown> }).zcash : undefined;
  const fee = (k: string) => (Number.isSafeInteger(z?.[k]) ? BigInt(z![k] as number) : undefined);
  const eta = (k: string) => {
    const v = z?.[k];
    return typeof v === 'string' ? v : undefined;
  };
  const [depositFeeZat, withdrawFeeZat] = [fee('depositFee'), fee('withdrawalFee')];
  const [depositEta, withdrawEta] = [eta('depositEta'), eta('withdrawalEta')];
  if (depositFeeZat === undefined || withdrawFeeZat === undefined || !depositEta || !withdrawEta) {
    throw new Error('unit did not say what zec costs right now');
  }
  return { depositFeeZat, depositEta, withdrawFeeZat, withdrawEta };
}

/** one zec deposit or withdrawal as Unit sees it */
export interface UnitOperation {
  /** the source transaction; `txid:vout` for zcash, `sender:nonce` for hyperliquid */
  sourceTx: string;
  way: 'deposit' | 'withdraw';
  zat: bigint;
  /** Unit's own state word (sourceTxDiscovered ... done, failure) */
  state: string;
  /** source confirmations so far; absent once the source is final */
  confirmations?: number;
  createdAt: string;
}

/** the zec operations of a Hyperliquid account, newest first as Unit sorts them */
export async function unitZecOperations(
  account: string,
  fetchFn: FetchFn = fetch,
): Promise<UnitOperation[]> {
  const res = await fetchFn(`${UNIT_API}/operations/${account}`);
  if (!res.ok) {
    throw new Error(`unit did not answer: ${res.status}`);
  }
  const { operations } = (await res.json()) as { operations?: Record<string, unknown>[] };
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return (Array.isArray(operations) ? operations : []).flatMap(o => {
    const way =
      o['sourceChain'] === 'zcash' ? 'deposit' : o['destinationChain'] === 'zcash' ? 'withdraw' : 0;
    const amount = text(o['sourceAmount']);
    if (!way || o['asset'] !== 'zec' || !/^\d+$/.test(amount)) {
      return [];
    }
    return [
      {
        sourceTx: text(o['sourceTxHash']),
        way,
        zat: BigInt(amount),
        state: text(o['state']),
        ...(typeof o['sourceTxConfirmations'] === 'number'
          ? { confirmations: o['sourceTxConfirmations'] }
          : {}),
        createdAt: text(o['opCreatedAt']),
      },
    ];
  });
}

/** an operation that will not change again */
export const unitSettled = (o: UnitOperation): boolean =>
  o.state === 'done' || o.state === 'failure';
