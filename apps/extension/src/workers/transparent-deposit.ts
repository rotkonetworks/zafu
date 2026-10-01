/**
 * A t->t deposit with an OP_RETURN memo (a THORChain swap out of zec), as two
 * services over a chain client and the wasm: `planDeposit` prices it from the
 * address's UTXOs with no key, for the review; `sendDeposit` builds it from
 * public data, has SpendKeys sign it, checks the signed bytes pay exactly what
 * was reviewed, and broadcasts.
 *
 * Every input comes from the one address `tAddress` (the pocket's index 0), and
 * change returns to it, because THORChain refunds to whoever funded vin[0].
 */

import { transparentAddressToScriptHex } from '../ledger/address';
import type { SpendKeys } from './hot-sign';

export interface DepositRequest {
  /** the pocket's transparent address at index 0: funds, change and refunds */
  tAddress: string;
  /** the vault, paid at vout 0 */
  to: string;
  amountZat: string;
  /** sent verbatim as the OP_RETURN payload */
  memo: string;
  mainnet: boolean;
}

export interface DepositPlan {
  fee: string;
  change: string;
  /** zatoshi the address is missing; '0' when it can pay */
  short: string;
}

interface Utxo {
  txid: Uint8Array;
  outputIndex: number;
  valueZat: bigint;
  script: Uint8Array;
}

/** what the deposit needs from the zcash backend */
export interface DepositChain {
  utxos: (address: string) => Promise<Utxo[]>;
  tip: () => Promise<number>;
  branchId: () => Promise<number>;
  /** the txid the network accepted */
  broadcast: (txHex: string) => Promise<string>;
}

/** zcli crates/zcash-wasm/src/transparent_send.rs */
export interface DepositWasm {
  plan_transparent_transaction(
    utxos_json: string,
    amount: bigint,
    null_data_hex?: string | null,
  ): string;
  build_unsigned_transparent_transaction(
    utxos_json: string,
    pubkey_hex: string,
    recipient: string,
    amount: bigint,
    target_height: number,
    expected_branch_id: number,
    mainnet: boolean,
    null_data_hex?: string | null,
  ): string;
}

type Keys = Pick<SpendKeys, 'transparent_pubkey' | 'sign_shielding'>;

export const FEE_MOVED = 'the network fee changed since your review · please review it again';

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));

const utxosJson = (utxos: Utxo[]) =>
  JSON.stringify(
    utxos.map(u => ({
      txid: hex(u.txid),
      vout: u.outputIndex,
      value: u.valueZat.toString(),
      script: hex(u.script),
    })),
  );

const memoHex = (memo: string) => hex(new TextEncoder().encode(memo));

/** OP_RETURN <push> <data>, OP_PUSHDATA1 past 75 bytes */
export const opReturnScript = (dataHex: string): string => {
  const n = dataHex.length / 2;
  return `6a${n > 75 ? '4c' : ''}${n.toString(16).padStart(2, '0')}${dataHex}`;
};

/** the outputs of a transparent-only V5 transaction */
export const transparentOutputs = (txHex: string): { value: bigint; script: string }[] => {
  const b = fromHex(txHex);
  let at = 20; // version, group id, branch id, lock time, expiry
  const size = () => {
    const first = b[at++]!;
    if (first < 0xfd) {
      return first;
    }
    const len = first === 0xfd ? 2 : 4;
    let n = 0;
    for (let i = 0; i < len; i++) {
      n |= b[at + i]! << (8 * i);
    }
    at += len;
    return n;
  };
  for (let i = size(); i > 0; i--) {
    at += 36;
    const script = size();
    at += script + 4;
  }
  return Array.from({ length: size() }, () => {
    let value = 0n;
    for (let i = 7; i >= 0; i--) {
      value = (value << 8n) | BigInt(b[at + i]!);
    }
    at += 8;
    const len = size();
    const script = hex(b.subarray(at, at + len));
    at += len;
    return { value, script };
  });
};

/** throws unless the signed bytes pay [to, OP_RETURN(memo), change to own] and nothing else */
export const checkDeposit = (
  txHex: string,
  want: { toScript: string; amountZat: bigint; memoHex: string; ownScript: string },
): void => {
  const [pay, memo, ...change] = transparentOutputs(txHex);
  const ok =
    pay?.script === want.toScript &&
    pay.value === want.amountZat &&
    memo?.value === 0n &&
    memo.script === opReturnScript(want.memoHex) &&
    change.length <= 1 &&
    change.every(c => c.script === want.ownScript);
  if (!ok) {
    throw new Error('the signed deposit does not match your review · nothing was sent');
  }
};

export const planDeposit = async (
  wasm: DepositWasm,
  chain: DepositChain,
  req: DepositRequest,
): Promise<DepositPlan> => {
  const p = JSON.parse(
    wasm.plan_transparent_transaction(
      utxosJson(await chain.utxos(req.tAddress)),
      BigInt(req.amountZat),
      memoHex(req.memo),
    ),
  ) as { fee: number; change: number; short: number };
  return { fee: String(p.fee), change: String(p.change), short: String(p.short) };
};

export const sendDeposit = async (
  wasm: DepositWasm,
  chain: DepositChain,
  keys: Keys,
  req: DepositRequest & { reviewedFee: string },
): Promise<{ txid: string; fee: string; txHex: string }> => {
  const utxos = await chain.utxos(req.tAddress);
  const [height, branchId] = await Promise.all([chain.tip(), chain.branchId()]);
  const data = memoHex(req.memo);
  const built = JSON.parse(
    wasm.build_unsigned_transparent_transaction(
      utxosJson(utxos),
      keys.transparent_pubkey(0),
      req.to,
      BigInt(req.amountZat),
      height + 1,
      branchId,
      req.mainnet,
      data,
    ),
  ) as { fee: number; sighashes: string[]; unsigned_tx_hex: string };
  if (String(built.fee) !== req.reviewedFee) {
    throw new Error(FEE_MOVED);
  }
  const txHex = keys.sign_shielding(0, built.unsigned_tx_hex, JSON.stringify(built.sighashes));
  checkDeposit(txHex, {
    toScript: await transparentAddressToScriptHex(req.to, req.mainnet),
    amountZat: BigInt(req.amountZat),
    memoHex: data,
    ownScript: hex(utxos[0]!.script),
  });
  return { txid: await chain.broadcast(txHex), fee: req.reviewedFee, txHex };
};
