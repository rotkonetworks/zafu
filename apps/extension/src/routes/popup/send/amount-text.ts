/**
 * A balance for reading, not for spending: at most 6 decimals, or 4
 * significant digits when it is all below that, cut down (never rounded up)
 * so it cannot overstate what is there. A token with a large exponent
 * otherwise prints 30-odd digits.
 */
export const shortAmount = (amount: string): string => {
  const [int = '0', frac = ''] = amount.split('.');
  if (frac.length <= 6) {
    return amount;
  }
  const lead = /^0*$/.test(int) ? (/^0*/.exec(frac)?.[0].length ?? 0) : 0;
  const keep = Math.max(6, lead + 4);
  const cut = frac.slice(0, keep).replace(/0+$/, '');
  return cut ? `${int}.${cut}` : int;
};
