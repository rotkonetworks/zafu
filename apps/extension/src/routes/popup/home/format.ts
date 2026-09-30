/**
 * Format ZEC with meaningful digits only - no trailing zeros, min 2 decimals.
 * `maxDecimals` caps precision (default 8, full precision); the hero balance
 * card passes 4 so a long amount fits without overflowing - full precision
 * stays available in the pool view.
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

/** hero balance formatter - see `fmtZec`'s `maxDecimals`. */
export function fmtZecHero(val: number): string {
  return fmtZec(val, 4);
}

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
