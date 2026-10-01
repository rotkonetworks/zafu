export type ZignerChain = 'zcash' | 'penumbra';

/**
 * Which chain a zigner code belongs to, from its text alone: zcash rides
 * `ur:zcash-*` / `ur:zigner-module` or the `53 04` prelude, penumbra rides
 * `ur:penumbra-*`, the `53 03` prelude, or its bare signature reply (an
 * effect hash and counts, at least 66 bytes of hex). Undefined when unsure.
 */
export const zignerCodeChain = (text: string): ZignerChain | undefined => {
  const t = text.trim().toLowerCase();
  if (t.startsWith('ur:')) {
    const type = t.slice(3).split('/')[0] ?? '';
    return type.startsWith('zcash-') || type === 'zigner-module'
      ? 'zcash'
      : type.startsWith('penumbra-')
        ? 'penumbra'
        : undefined;
  }
  if (!/^[0-9a-f]+$/.test(t) || t.length % 2 !== 0) {
    return undefined;
  }
  return t.startsWith('5304')
    ? 'zcash'
    : t.startsWith('5303')
      ? 'penumbra'
      : !t.startsWith('53') && t.length >= 132
        ? 'penumbra'
        : undefined;
};
