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
export function injectiveScanIndices(highest: number, cap = MAX_INJECTIVE_SCAN): number[] {
  const top = Number.isSafeInteger(highest) && highest > 0 ? highest : 0;
  const size = Math.max(1, Math.floor(cap));
  const start = Math.max(1, top - (size - 1) + 1);
  const out = [0];
  for (let i = start; i <= top && out.length < size; i++) {
    out.push(i);
  }
  return out;
}

export interface InjectiveIndexBalance {
  index: number;
  address: string;
  /** USDC.inj base units (6-dec) */
  usdc: bigint;
  /** INJ base units (18-dec) */
  inj: bigint;
}

/**
 * Default index for the shield / withdraw forms: the one with the largest
 * USDC.inj balance (ties -> lowest index), or 0 when nothing holds USDC.
 */
export function pickDefaultInjectiveIndex(rows: readonly { index: number; usdc: bigint }[]): number {
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
