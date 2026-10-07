import { encodeOrchardUfvk } from '@repo/wallet/networks/zcash/unified-address';

/**
 * The unified viewing key a zcash wallet syncs and builds with, or undefined
 * when it has none. A wallet added from a pre-UR zigner code stored only the
 * raw 96-byte orchard key, base64; it is read as the orchard-only key it is,
 * so such a wallet syncs without being added again.
 */
export const zcashViewKey = (
  w: { ufvk?: string; orchardFvk?: string; mainnet: boolean } | undefined,
): string | undefined => {
  if (!w || w.ufvk) {
    return w?.ufvk;
  }
  const fvk = w.orchardFvk ?? '';
  if (fvk.startsWith('uview')) {
    return fvk;
  }
  try {
    const raw = Uint8Array.from(atob(fvk), c => c.charCodeAt(0));
    return raw.length === 96 ? encodeOrchardUfvk(raw, w.mainnet) : undefined;
  } catch {
    return undefined;
  }
};
