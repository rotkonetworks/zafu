/**
 * Pure helpers for Injective burner-address visibility in the receive panel.
 *
 * `zafu_get_fresh_chain_address` hands dapps a fresh inj1 burner per unshield,
 * allocated by `nextHdIndex('injective')` (post-increment: the stored counter is
 * the highest index handed out so far). The panel reads that counter with
 * `peekHdIndex` (never increments it), derives each index via
 * deriveInjectiveAddress (coin type 60 - never the cosmos 118 path), and lets
 * the user shield / withdraw from whichever index holds the funds.
 */

/** hard cap on how many indices the panel derives + queries per poll. */
export const MAX_INJECTIVE_SCAN = 20;

/**
 * The HD indices to scan, given the highest index handed out (`peekHdIndex`).
 * Always includes 0 (the stable receive address). When more burners exist than
 * the cap allows, the MOST RECENT ones are scanned: freshly issued burners are
 * the likeliest to hold unshielded funds.
 */
export function injectiveScanIndices(
  highest: number,
  cap = MAX_INJECTIVE_SCAN,
  /**
   * Indices that have ever held funds. Always scanned, on top of the recent
   * window: receive addresses rotate on every open, so an old address can
   * fall out of the window and must not vanish while it still holds money.
   */
  alwaysScan: readonly number[] = [],
): number[] {
  const top = Number.isSafeInteger(highest) && highest > 0 ? highest : 0;
  const size = Math.max(1, Math.floor(cap));
  const start = Math.max(1, top - (size - 1) + 1);
  const out = new Set([0]);
  for (let i = start; i <= top && out.size < size; i++) {
    out.add(i);
  }
  for (const i of alwaysScan) {
    if (Number.isSafeInteger(i) && i >= 0 && i <= top) {
      out.add(i);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export interface InjectiveIndexBalance {
  index: number;
  address: string;
  /** USDC.inj base units (6-dec) */
  usdc: bigint;
  /** INJ base units (18-dec) */
  inj: bigint;
  /** every bank balance on the address */
  all?: { denom: string; amount: bigint }[];
}

/**
 * Default index for the shield / withdraw forms: the one with the largest
 * USDC.inj balance (ties -> lowest index), or 0 when nothing holds USDC.
 */
export function pickDefaultInjectiveIndex(
  rows: readonly { index: number; usdc: bigint }[],
): number {
  let best: { index: number; usdc: bigint } | undefined;
  for (const r of rows) {
    if (r.usdc <= 0n) {
      continue;
    }
    if (!best || r.usdc > best.usdc || (r.usdc === best.usdc && r.index < best.index)) {
      best = r;
    }
  }
  return best?.index ?? 0;
}

/** indices in `rows` holding anything, merged into the remembered set. */
export function mergeFundedIndices(
  remembered: readonly number[],
  rows: readonly InjectiveIndexBalance[],
): number[] {
  const out = new Set(remembered);
  for (const r of rows) {
    if (r.usdc > 0n || r.inj > 0n) {
      out.add(r.index);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** burner (index > 0) rows that hold anything - drives whether the picker shows. */
export function fundedBurners<T extends InjectiveIndexBalance>(rows: readonly T[]): T[] {
  return rows.filter(r => r.index > 0 && (r.usdc > 0n || r.inj > 0n));
}

/**
 * The index the forms act on: the user's pick while it is still one of the
 * offered options (index 0 or a funded burner), else the default. Every
 * balance check, the sponsor, and the signer must all use this one value.
 */
export function resolveSelectedInjectiveIndex(
  rows: readonly InjectiveIndexBalance[],
  userPick: number | undefined,
): number {
  const offered = new Set([0, ...fundedBurners(rows).map(r => r.index)]);
  if (userPick !== undefined && offered.has(userPick) && rows.some(r => r.index === userPick)) {
    return userPick;
  }
  return pickDefaultInjectiveIndex(rows);
}

/** inj1abcd...wxyz */
export function shortInjAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}...${address.slice(-4)}` : address;
}
