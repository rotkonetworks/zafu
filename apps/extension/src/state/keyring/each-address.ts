/** a random order, so the node cannot read the derivation order off the requests */
const shuffled = <T>(xs: readonly T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * Each address asked on its own, one after another. Several addresses in one
 * request tell the node they are one wallet; zafu hands every swap its own
 * address so that they are not.
 */
export const eachAddress = async <T>(
  addresses: readonly string[],
  ask: (address: string) => Promise<T[]>,
): Promise<T[]> => {
  const out: T[] = [];
  for (const a of shuffled([...new Set(addresses.filter(Boolean))])) {
    out.push(...(await ask(a)));
  }
  return out;
};
