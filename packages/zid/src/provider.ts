/**
 * zafu wallet provider detection and session delegation.
 *
 * The wallet calls go through a pluggable ZafuTransport (./transport) carrying
 * typed @zafu/protocol requests, so the message shapes here are the SAME
 * contract the wallet handlers are checked against - no more hand-built,
 * drifting message literals.
 */

import type { ZidOptions } from './types';
import { createExtensionTransport, type ZafuHandle } from './transport';

/** ed25519 session keypair via Web Crypto */
export async function createSessionKey() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const pubkey = hex(pubRaw);

  return {
    pubkey,
    keyPair,
    sign: async (data: Uint8Array): Promise<string> => {
      const sig = new Uint8Array(
        await crypto.subtle.sign('Ed25519', keyPair.privateKey, data as BufferSource),
      );
      return hex(sig);
    },
    verify: async (data: Uint8Array, sigHex: string, pubkeyHex: string): Promise<boolean> => {
      const sigBytes = unhex(sigHex);
      const pubBytes = unhex(pubkeyHex);
      const key = await crypto.subtle.importKey('raw', pubBytes, 'Ed25519', false, ['verify']);
      return crypto.subtle.verify('Ed25519', key, sigBytes, data as BufferSource);
    },
  };
}

/**
 * Detect the zafu wallet among the injected penumbra providers.
 *
 * There can be several (e.g. Prax installed alongside zafu), so we ping each and
 * return the one that answers the zafu handshake (`{ zafu: true }`). Picking
 * `entries[0]` blindly - as this did before - silently fails detection whenever
 * another penumbra wallet happens to be listed first.
 */
export async function detectZafu(): Promise<ZafuHandle | null> {
  const providers = (globalThis as Record<symbol, unknown>)[Symbol.for('penumbra')];
  if (!providers || typeof providers !== 'object') {
    return null;
  }
  for (const [origin, provider] of Object.entries(providers as Record<string, unknown>)) {
    if (!provider) {
      continue;
    }
    const handle: ZafuHandle = { origin, provider };
    try {
      const pong = await createExtensionTransport(handle).request('ping', { type: 'ping' });
      if (
        pong &&
        typeof pong === 'object' &&
        'zafu' in pong &&
        (pong as { zafu?: unknown }).zafu === true
      ) {
        return handle;
      }
    } catch {
      // unreachable or non-zafu provider - try the next entry
    }
  }
  return null;
}

/** request delegation from zafu wallet */
export async function requestDelegation(
  zafu: ZafuHandle,
  sessionPubkey: string,
  opts: ZidOptions = {},
): Promise<{ walletPubkey: string; signature: string; network: string } | null> {
  try {
    // connect with timeout
    await Promise.race([
      zafu.provider.connect(),
      new Promise((_, rej) => {
        setTimeout(() => rej(new Error('timeout')), 3000);
      }),
    ]);

    const appName = opts.appName || globalThis.location?.hostname || 'zid-app';
    const delegationMsg = `zid:delegate:${sessionPubkey}:${appName}`;
    const challengeHex = hex(new TextEncoder().encode(delegationMsg));

    // NOTE: opts.tradingMode / opts.sessionMinutes are session-layer hints the
    // v1 wallet handler does not read, so they are NOT put on the wire (that was
    // live drift - fields the wallet silently ignored). They belong to the
    // QUIC-style session/resumption design (v2), not the v1 zafu_sign request.
    // NOTE: the signature covers only `challengeHex` - the wallet does not bind
    // the origin. `delegationMsg` above therefore commits the session pubkey and
    // app name into the signed bytes; a server verifying this delegation must
    // also pin a fresh nonce + its own origin to stop cross-site replay.
    const transport = createExtensionTransport(zafu);
    const resp = (await transport.request('zafu_sign', {
      type: 'zafu_sign',
      challengeHex,
      statement: `Authorize ${appName}\nSession: ${sessionPubkey.slice(0, 16)}...`,
    }));

    if (resp.success && resp.publicKey && resp.signature) {
      return {
        walletPubkey: resp.publicKey,
        signature: resp.signature,
        // v1 zafu_sign carries no network field; zafu identity keys are penumbra-rooted.
        network: 'penumbra',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** pick contacts from zafu address book (opens extension picker UI) */
export async function pickContacts(
  zafu: ZafuHandle,
  opts: { purpose?: string; max?: number; appName?: string } = {},
): Promise<{ handle: string; displayName: string }[] | null> {
  try {
    // no appOrigin on the wire: the wallet uses the browser-attested
    // sender.origin, never a caller-supplied origin (privacy + anti-spoof).
    const transport = createExtensionTransport(zafu);
    const resp = (await transport.request('zafu_pick_contacts', {
      type: 'zafu_pick_contacts',
      purpose: opts.purpose || `${opts.appName || 'App'} wants to pick contacts`,
      max: opts.max || 1,
    }));

    if ('success' in resp && resp.success && Array.isArray(resp.contacts)) {
      return resp.contacts; // [{ handle, displayName }] - handles are app-scoped BLAKE2b
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ask the wallet to deliver an invite to a contact by opaque handle (wallet
 * resolves handle->pubkey and routes over an e2ee channel).
 *
 * Wallet-routed invite delivery is NOT a v1 @zafu/protocol method yet - the
 * wallet's zafu_send_invite handler is an unimplemented stub that always
 * refuses - so this reports `{ sent: false }` and the caller (zid.connect's
 * `invite`) falls back to delivering over its own zid channel. Kept as the seam
 * for when wallet-routed invites land (tracked with the social-messaging work);
 * at that point this dispatches the typed request through the transport.
 */
export function sendInvite(
  _zafu: ZafuHandle,
  _handle: string,
  _payload: { type: string; data: Record<string, unknown>; ttl?: number },
  _opts: { appName?: string; relayUrl?: string } = {},
): Promise<{ sent: boolean; delivered?: boolean }> {
  return Promise.resolve({ sent: false });
}

/** subscribe to incoming invites via zafu extension */
export function listenInvites(
  zafu: ZafuHandle,
  handler: (invite: {
    appOrigin: string;
    type: string;
    data: Record<string, unknown>;
    fromName: string;
    accept: () => void;
    decline: () => void;
  }) => void,
): () => void {
  // reach chrome.runtime via globalThis - zid ships to plain web pages and
  // carries no @types/chrome; this call is a no-op where the extension bus is
  // absent (returns an unsubscribe that does nothing).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chrome.runtime is untyped here (no @types/chrome)
  const rt = (globalThis as { chrome?: { runtime?: any } }).chrome?.runtime;
  if (!rt?.onMessage) {
    return () => {
      /* no wallet message bus present: nothing to unsubscribe */
    };
  }
  const extId = zafu.origin.replace('chrome-extension://', '').replace(/\/$/, '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chrome message + sender args are untyped
  const listener = (msg: any, sender: any) => {
    if (sender.id !== extId) {return;}
    if (msg?.type !== 'zafu_incoming_invite') {return;}
    handler({
      appOrigin: msg.appOrigin,
      type: msg.inviteType,
      data: msg.data,
      fromName: msg.fromName,
      accept: () => {
        rt.sendMessage(extId, { type: 'zafu_invite_response', id: msg.inviteId, accepted: true });
      },
      decline: () => {
        rt.sendMessage(extId, { type: 'zafu_invite_response', id: msg.inviteId, accepted: false });
      },
    });
  };
  rt.onMessage.addListener(listener);
  return () => rt.onMessage.removeListener(listener);
}

// hex helpers
function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
function unhex(h: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);}
  return bytes;
}
