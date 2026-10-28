/**
 * Zigner's "export key" QR wraps an address as `<scheme>:<address>:0x<genesis
 * hash>` (the polkadot-js format). A send screen wants only the address.
 */
const SIGNER_EXPORT = /^(?:substrate|ethereum|cosmos|zcash|penumbra):([^:]+):0x[0-9a-f]{64}$/i;

export const scannedAddress = (text: string): string => {
  const trimmed = text.trim();
  return SIGNER_EXPORT.exec(trimmed)?.[1] ?? trimmed;
};
