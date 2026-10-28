/**
 * Zigner's "export key" QR wraps an address as `<scheme>:<address>:0x<genesis
 * hash>` (the polkadot-js format). A send screen wants only the address.
 *
 * Every Zigner up to 0.12.0 tags penumbra keys `substrate:` and shows a
 * penumbra address its own viewing key does not own: funds sent there can
 * never be found or spent (zigner#35). Fixed Zigner tags them `penumbra:`, so
 * the old tag is refused rather than unwrapped.
 */
const SIGNER_EXPORT = /^(substrate|ethereum|cosmos|zcash|penumbra):([^:]+):0x[0-9a-f]{64}$/i;

export const OLD_ZIGNER_PENUMBRA =
  'this zigner shows a penumbra address its own key cannot spend from. update zigner before receiving there, and do not send to it';

export type Scanned = { address: string; refused?: undefined } | { address: ''; refused: string };

export const scannedAddress = (text: string): Scanned => {
  const trimmed = text.trim();
  const m = SIGNER_EXPORT.exec(trimmed);
  if (!m) {
    return { address: trimmed };
  }
  const [, scheme, address] = m;
  if (scheme!.toLowerCase() === 'substrate' && address!.toLowerCase().startsWith('penumbra1')) {
    return { address: '', refused: OLD_ZIGNER_PENUMBRA };
  }
  return { address: address! };
};
