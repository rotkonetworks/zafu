/**
 * Format ZEC with meaningful digits only - no trailing zeros, min 2 decimals.
 * `maxDecimals` caps precision (default 8, full precision).
 */
export function fmtZec(val: number, maxDecimals = 8): string {
  if (val === 0) {
    return '0';
  }
  const s = val.toFixed(maxDecimals).replace(/0+$/, '').replace(/\.$/, '');
  const dot = s.indexOf('.');
  if (dot === -1) {
    return s + '.00';
  }
  const decimals = s.length - dot - 1;
  return decimals < 2 ? s + '0'.repeat(2 - decimals) : s;
}

/** home's figures: four fixed decimals, so amounts line up (full precision
 *  stays in the pool view) */
export const fmtZecHero = (val: number): string => val.toFixed(4);

export function zatToZec(zat: bigint | string): string {
  const v = typeof zat === 'string' ? BigInt(zat) : zat;
  const w = v / 100_000_000n;
  const f = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${w}.${f}`;
}

export function fmtTime(ts: number | null): string {
  if (ts === null) {
    return '...';
  }
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) {
    return `today ${t}`;
  }
  if (diff === 1) {
    return `yesterday ${t}`;
  }
  if (diff < 7) {
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}
