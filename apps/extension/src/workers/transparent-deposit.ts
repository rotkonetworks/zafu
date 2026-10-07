/**
 * A t->t deposit with an OP_RETURN memo (a THORChain swap out of zec), as two
 * services over a chain client and the wasm: `planDeposit` prices it from the
 * address's UTXOs with no key, for the review; `buildDeposit` builds it from
 * public data, a signer signs it (SpendKeys in the worker for a hot wallet,
 * zigner over QR for a cold one), and `finishDeposit` checks the signed bytes
 * pay exactly what was reviewed before it broadcasts.
 *
 * Every input comes from the one address `tAddress` (the swap's own fresh
 * t-branch index `tIndex`), and change returns to it, because THORChain
 * refunds to whoever funded vin[0]. Each swap has its own address, so no two
 * swaps share inputs, change or refunds on chain.
 */

import { payableTransparentAddress, transparentAddressToScriptHex } from '../ledger/address';
import type { SpendKeys } from './hot-sign';

export interface DepositRequest {
  /** the swap's own transparent address: funds, change and refunds */
  tAddress: string;
  /** its t-branch index in the pocket: the key that signs */
  tIndex: number;
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

export const VAULT_UNPAYABLE = "this vault is an address zafu can't pay · nothing was moved";

/**
 * Throws unless `to` is a transparent address this deposit can pay: base58
 * t1/t3, or a ZIP 320 tex address (its P2PKH; this deposit spends only
 * transparent inputs, as tex requires). Asked before anything moves.
 */
export const checkVault = async (to: string, mainnet: boolean): Promise<void> => {
  try {
    await transparentAddressToScriptHex(to, mainnet);
  } catch {
    throw new Error(VAULT_UNPAYABLE);
  }
};

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

/** the inputs (display-order txid, vout) and outputs of a transparent-only V5 transaction */
const transparentParts = (txHex: string) => {
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
  const inputs = Array.from({ length: size() }, () => {
    const txid = hex(b.slice(at, at + 32).reverse());
    const vout =
      (b[at + 32]! | (b[at + 33]! << 8) | (b[at + 34]! << 16) | (b[at + 35]! << 24)) >>> 0;
    at += 36;
    const script = size();
    at += script + 4;
    return { txid, vout };
  });
  const outputs = Array.from({ length: size() }, () => {
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
  return { inputs, outputs };
};

/** the outputs of a transparent-only V5 transaction */
export const transparentOutputs = (txHex: string): { value: bigint; script: string }[] =>
  transparentParts(txHex).outputs;

/** the outpoints a transparent-only V5 transaction spends */
export const transparentInputs = (txHex: string): { txid: string; vout: number }[] =>
  transparentParts(txHex).inputs;

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

/**
 * The ZIP-317 fee of a deposit with a `memoBytes` OP_RETURN, as the wasm
 * planner (plan_transparent_transaction) prices it: 5,000 zat per logical
 * action, at least 2; a P2PKH input is 150 bytes, and the outputs are the
 * vault and a change output (always counted, 34 bytes each) plus the
 * OP_RETURN (8 value + 1 length + its script). A swap's own fresh address is
 * funded by one move, so it spends one input. Checked against the wasm in
 * transparent-deposit.test.ts.
 */
export const depositFeeZat = (memoBytes: number, inputs = 1): bigint => {
  const opReturn = memoBytes ? 9 + 1 + (memoBytes > 75 ? 2 : 1) + memoBytes : 0;
  const actions = Math.max(2, inputs, Math.ceil((34 + 34 + opReturn) / 34));
  return 5000n * BigInt(actions);
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

/** what the signed bytes must pay: the review, and change back to the funding address */
export interface DepositWant {
  toScript: string;
  amountZat: bigint;
  memoHex: string;
  ownScript: string;
}

export interface BuiltDeposit {
  /** the unsigned PCZT */
  pcztHex: string;
  /** one per input, for a signer that signs sighashes */
  sighashes: string[];
  want: DepositWant;
}

/**
 * Build the reviewed deposit from public data: the address's coins and the
 * pubkey of the key that signs (`pubkeyHex`, the swap's own t-branch index).
 * Refuses an unpayable vault, and a fee that moved since the review. Hot and
 * cold build the same bytes; only who signs them differs.
 */
export const buildDeposit = async (
  wasm: DepositWasm,
  chain: DepositChain,
  pubkeyHex: string,
  req: DepositRequest & { reviewedFee: string },
): Promise<BuiltDeposit> => {
  await checkVault(req.to, req.mainnet);
  // a tex vault is paid as its P2PKH twin: the same output bytes, from transparent inputs only
  const [recipient, toScript] = await Promise.all([
    payableTransparentAddress(req.to, req.mainnet),
    transparentAddressToScriptHex(req.to, req.mainnet),
  ]);
  const utxos = await chain.utxos(req.tAddress);
  const [height, branchId] = await Promise.all([chain.tip(), chain.branchId()]);
  const data = memoHex(req.memo);
  const built = JSON.parse(
    wasm.build_unsigned_transparent_transaction(
      utxosJson(utxos),
      pubkeyHex,
      recipient,
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
  return {
    pcztHex: built.unsigned_tx_hex,
    sighashes: built.sighashes,
    // the wasm refuses any coin that is not this pubkey's P2PKH, so every input pays this script
    want: {
      toScript,
      amountZat: BigInt(req.amountZat),
      memoHex: data,
      ownScript: hex(utxos[0]!.script),
    },
  };
};

/** check the signed bytes pay exactly what was reviewed, then broadcast them */
export const finishDeposit = async (
  chain: DepositChain,
  txHex: string,
  want: DepositWant,
  fee: string,
): Promise<{ txid: string; fee: string; txHex: string }> => {
  checkDeposit(txHex, want);
  return { txid: await chain.broadcast(txHex), fee, txHex };
};

/** hot: SpendKeys signs the swap's own index in the worker */
export const sendDeposit = async (
  wasm: DepositWasm,
  chain: DepositChain,
  keys: Keys,
  req: DepositRequest & { reviewedFee: string },
): Promise<{ txid: string; fee: string; txHex: string }> => {
  const built = await buildDeposit(wasm, chain, keys.transparent_pubkey(req.tIndex), req);
  const txHex = keys.sign_shielding(req.tIndex, built.pcztHex, JSON.stringify(built.sighashes));
  return finishDeposit(chain, txHex, built.want, req.reviewedFee);
};

/**
 * A device-signed PCZT's transparent signatures, one per input in order.
 *
 * A PCZT input keeps `partial_signatures: BTreeMap<[u8; 33], Vec<u8>>`; in
 * the serialized PCZT that is the 33-byte pubkey, a length and DER || 0x01
 * (SIGHASH_ALL). Each one is read where the signer's own pubkey is followed by
 * exactly that shape, which the pubkey's other places in a PCZT (its hash160
 * preimage, a derivation key) never are. Nothing here is trusted: the wasm
 * verifies every signature against its input's sighash and key before it
 * finalizes, and the finished bytes are checked against the review.
 */
export const transparentSignaturesOf = (
  signedPczt: Uint8Array,
  pubkeyHex: string,
): { sig_hex: string; pubkey_hex: string }[] => {
  const key = fromHex(pubkeyHex);
  const found: { sig_hex: string; pubkey_hex: string }[] = [];
  for (let at = 0; at + key.length + 2 < signedPczt.length; at++) {
    if (!key.every((b, i) => signedPczt[at + i] === b)) {
      continue;
    }
    const len = signedPczt[at + key.length]!;
    const sig = signedPczt.subarray(at + key.length + 1, at + key.length + 1 + len);
    // DER: SEQUENCE (0x30), its length, then the sighash byte
    if (
      len >= 9 &&
      len <= 73 &&
      sig.length === len &&
      sig[0] === 0x30 &&
      sig[1] === len - 3 &&
      sig[len - 1] === 0x01
    ) {
      found.push({ sig_hex: hex(sig), pubkey_hex: pubkeyHex });
      at += key.length + len;
    }
  }
  return found;
};

/** zcli crates/zcash-wasm: apply transparent signatures, finalize, extract */
export interface FinalizeWasm {
  complete_shielding_pczt(pczt_hex: string, signatures_json: string): string;
}

/**
 * Cold: the device signed the PCZT. Its signatures are applied to the PCZT
 * zafu built (verified against each input's sighash and key), the spends
 * finalized and the tx extracted - the same completion the hot SpendKeys
 * runs. Whatever else the device's PCZT says is not used.
 */
export const signedDepositTx = (
  wasm: FinalizeWasm,
  unsignedPcztHex: string,
  signedPczt: Uint8Array,
  pubkeyHex: string,
): string => {
  const sigs = transparentSignaturesOf(signedPczt, pubkeyHex);
  if (sigs.length === 0) {
    throw new Error('zigner returned this deposit unsigned · nothing was sent');
  }
  return wasm.complete_shielding_pczt(unsignedPcztHex, JSON.stringify(sigs));
};

/**
 * Cold, the second half: the device's signed PCZT finished against the PCZT
 * zafu built and showed it, then held to the review - the vault, the amount,
 * the memo, and change back to the swap's own address. Nothing is broadcast:
 * the bytes may be held until the coin they spend is mined.
 */
export const coldDepositTx = async (
  wasm: FinalizeWasm,
  req: DepositRequest,
  signed: { unsignedPcztHex: string; signedPczt: Uint8Array; pubkeyHex: string },
): Promise<string> => {
  const txHex = signedDepositTx(wasm, signed.unsignedPcztHex, signed.signedPczt, signed.pubkeyHex);
  checkDeposit(txHex, await wantOf(req));
  return txHex;
};

/** what a deposit's signed bytes must pay, from the request alone */
export const wantOf = async (req: DepositRequest): Promise<DepositWant> => {
  await checkVault(req.to, req.mainnet);
  const [toScript, ownScript] = await Promise.all([
    transparentAddressToScriptHex(req.to, req.mainnet),
    transparentAddressToScriptHex(req.tAddress, req.mainnet),
  ]);
  return { toScript, amountZat: BigInt(req.amountZat), memoHex: memoHex(req.memo), ownScript };
};

/** frost_inspect_pczt_outputs, as much of it as a move's coin needs */
export interface MoveInspected {
  computed_sighash_hex: string;
  transparent_input_count: number;
  transparent_outputs: { value_zat: number; script_pubkey_hex: string; address: string | null }[];
  expiry_height: number;
}

export interface MoveCoin {
  /** display order, as the deposit's utxo list takes it */
  txid: string;
  vout: number;
  value: string;
  script: string;
  /** the last height the move can be mined at */
  expiry: number;
}

export const MOVE_MISMATCH =
  "the move zafu built doesn't fund this swap as reviewed · nothing was sent";

/**
 * The coin a move leaves on the swap's address, read from the move's
 * unsigned PCZT (frost_inspect_pczt_outputs) before anything is signed. A
 * move has no transparent inputs, so its shielded sighash is its txid (ZIP
 * 244; zcli tests/move_txid_before_signing.rs), and the deposit can spend
 * (txid, vout) at once. Refuses any move that does not pay the address
 * exactly `shortZat` in one output.
 */
export const moveCoin = (m: MoveInspected, tAddress: string, shortZat: string): MoveCoin => {
  const vout = m.transparent_outputs.findIndex(o => o.address === tAddress);
  const out = m.transparent_outputs[vout];
  if (
    m.transparent_input_count !== 0 ||
    m.transparent_outputs.length !== 1 ||
    !out ||
    String(out.value_zat) !== shortZat ||
    !/^[0-9a-f]{64}$/.test(m.computed_sighash_hex)
  ) {
    throw new Error(MOVE_MISMATCH);
  }
  return {
    txid: m.computed_sighash_hex.match(/../g)!.reverse().join(''),
    vout,
    value: shortZat,
    script: out.script_pubkey_hex,
    expiry: m.expiry_height,
  };
};

/** the chain as it will be once `coin` is mined: the deposit can be built and signed now */
export const withCoin = (chain: DepositChain, coin?: MoveCoin): DepositChain =>
  coin
    ? {
        ...chain,
        utxos: async address => [
          ...(await chain.utxos(address)),
          {
            txid: fromHex(coin.txid),
            outputIndex: coin.vout,
            valueZat: BigInt(coin.value),
            script: fromHex(coin.script),
          },
        ],
      }
    : chain;
