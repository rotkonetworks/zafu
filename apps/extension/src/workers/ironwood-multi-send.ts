/**
 * A site's send with several outputs (`zafu_zcash_send`, e.g. a poker escrow
 * deposit plus rake): which builder it takes, and the outputs as the
 * multi-recipient ironwood builder (`build_ironwood_send_pczt_multi`) reads
 * them. From NU6.3 on every output is paid by ONE ironwood transaction; before
 * it the orchard builder pays them one transaction per output, as it always
 * has.
 */

export type MultiSendRoute = 'ironwood-one-tx' | 'orchard-per-output';

/** the builder for a send at `tipHeight`, given NU6.3's activation height */
export const multiSendRoute = (tipHeight: number, nu63Activation: number): MultiSendRoute =>
  tipHeight >= nu63Activation ? 'ironwood-one-tx' : 'orchard-per-output';

/**
 * A memo as the wasm takes it: a zafu structured memo (hex starting `ff5a`)
 * passes through, any other text is its UTF-8 bytes in hex, none is null.
 * The same rule the single send applies.
 */
export const memoToHex = (memo: string | undefined): string | null => {
  if (!memo) {
    return null;
  }
  if (/^[0-9a-f]+$/i.test(memo) && memo.startsWith('ff5a')) {
    return memo;
  }
  return Array.from(new TextEncoder().encode(memo))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

/** one entry of `build_ironwood_send_pczt_multi`'s outputs_json */
export interface IronwoodMultiOutput {
  address: string;
  /** zatoshi */
  amount: number;
  memo_hex?: string;
}

export interface IronwoodMultiPlan {
  outputs: IronwoodMultiOutput[];
  /** sum of the amounts, zatoshi */
  total: bigint;
  /** shielded outputs (each one ironwood action before padding) */
  shielded: number;
  /** transparent outputs (each one transparent logical action) */
  transparent: number;
}

/**
 * The site's outputs for the multi-recipient ironwood builder, refusing what
 * it would refuse only after a prove: a memo for a transparent address (it has
 * no memo field), a non-positive or unsafe amount. Errors name the output by
 * index, never its address or value.
 */
export const planIronwoodMultiSend = (
  outputs: readonly { address: string; amount: string; memo?: string }[],
  isTransparent: (address: string) => boolean,
): IronwoodMultiPlan => {
  if (outputs.length === 0) {
    throw new Error('outputs array required');
  }
  let total = 0n;
  let shielded = 0;
  let transparent = 0;
  const planned = outputs.map((o, i) => {
    const address = o.address.trim();
    const amount = BigInt(o.amount);
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`output ${i}: invalid amount`);
    }
    const memoHex = memoToHex(o.memo);
    if (isTransparent(address)) {
      if (memoHex) {
        throw new Error(
          `output ${i}: a memo cannot be delivered to a transparent address - transparent ` +
            'outputs have no memo field',
        );
      }
      transparent++;
    } else {
      shielded++;
    }
    total += amount;
    return {
      address,
      amount: Number(amount),
      ...(memoHex ? { memo_hex: memoHex } : {}),
    };
  });
  return { outputs: planned, total, shielded, transparent };
};
