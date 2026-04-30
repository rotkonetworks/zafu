/**
 * internal ZID message listener
 *
 * Handles requests from internal extension pages (e.g. zitadel.html)
 * that need access to the user's full ZID ed25519 keypair to perform
 * cryptographic operations locally - signing, Noise channel DH, etc.
 *
 * Distinct from the external-encryption.ts listener:
 *   - external listener uses chrome.runtime.onMessageExternal and
 *     returns *only* public keys, with origin-based permission gating
 *   - this listener uses chrome.runtime.onMessage and returns the
 *     full keypair (including privkey), gated by:
 *       1. sender.id matches the extension itself (not an external dapp)
 *       2. sender.url is on an allowlist of trusted internal pages
 *       3. wallet is unlocked
 *
 * Returning the privkey to a renderer is a security tradeoff. The
 * trusted internal pages (Zitadel chat, etc.) need DH operations that
 * benefit from running in the page rather than the service worker
 * (latency, simpler streaming primitives, debuggability). The
 * tradeoff is acceptable because those pages ship as part of the
 * extension package and run under the same CSP.
 */

const ALLOWED_INTERNAL_PAGES = (): Set<string> => new Set([
  chrome.runtime.getURL('zitadel.html'),
]);

interface ZidKeypairRequest {
  type: 'zafu_zid_keypair';
  origin: string;
}

const isZidKeypairRequest = (req: unknown): req is ZidKeypairRequest =>
  typeof req === 'object' &&
  req !== null &&
  (req as Record<string, unknown>)['type'] === 'zafu_zid_keypair' &&
  typeof (req as Record<string, unknown>)['origin'] === 'string';

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');

export const internalZidListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): boolean => {
  if (!isZidKeypairRequest(req)) return false;

  // gate 1: must come from this extension, not an external page or dapp
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'internal-only' });
    return true;
  }

  // gate 2: must come from a known internal page
  const senderUrl = sender.url ?? '';
  const allowed = ALLOWED_INTERNAL_PAGES();
  const matched = [...allowed].some(p => senderUrl.startsWith(p));
  if (!matched) {
    sendResponse({ error: 'page not allowed' });
    return true;
  }

  void (async () => {
    try {
      // gate 3: wallet must be unlocked
      const { useStore } = await import('../../state');
      const keyInfo = useStore.getState().keyRing.selectedKeyInfo;
      if (!keyInfo) {
        sendResponse({ error: 'wallet locked' });
        return;
      }

      const mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);
      const { deriveZidKeypairForSite, DEFAULT_IDENTITY } = await import('../../state/identity');
      const { privateKey, publicKey } = deriveZidKeypairForSite(
        mnemonic, DEFAULT_IDENTITY, req.origin,
      );

      const pubHex = bytesToHex(publicKey);
      const privHex = bytesToHex(privateKey);
      // zeroize raw bytes after we've encoded them to hex
      privateKey.fill(0);

      sendResponse({ pubkey: pubHex, privkey: privHex });
    } catch (e) {
      sendResponse({ error: 'failed to derive keypair: ' + String(e) });
    }
  })();

  return true;
};
