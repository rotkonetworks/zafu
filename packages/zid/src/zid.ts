/**
 * zid - the simplest possible identity SDK
 *
 * detects zafu wallet → requests session → signs actions → opens e2ee channels
 * falls back to the guest (ephemeral, no-wallet) identity if no wallet is there:
 * the SAME crypto surface (ed25519 + X-Wing keys, sealed boxes, hybrid channel,
 * local contact discovery) so an app runs unchanged whether or not zafu is
 * installed. See ./guest for the derivation and its custody caveats.
 *
 * contacts live in zid (localStorage), not in the wallet.
 * zafu provides richer contacts - zid uses them when available, works without.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type {
  ZidIdentity,
  ZidOptions,
  PickContactsOptions,
  InvitePayload,
  IncomingInvite,
  AdvertisedKeys,
} from './types';
import {
  createSessionKey,
  detectZafu,
  requestDelegation,
  pickContacts as providerPickContacts,
  sendInvite,
  listenInvites,
} from './provider';
import { createChannel } from './channel';
import { openChannel } from './channel-select';
import { getContactRefs, resolveHandle, upsertContact } from './contacts';
import { createGuestIdentity } from './guest';
import { decryptFrom, encryptFor, type ZidRecipient } from './messaging';
import { ZafuError } from './errors';
import type { ZafuHandle } from './transport';
import { interaction, interactionKey } from '@zafu/interactions';

const bytesToBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const base64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** the zid singleton */
export const zid = {
  /**
   * connect to zafu wallet or generate an ephemeral identity.
   *
   * ```typescript
   * const me = await zid.connect({ appName: 'poker.zk.bot' })
   * console.log(me.pubkey) // ed25519 hex
   * ```
   *
   * `me.channel()` uses the post-quantum hybrid Noise handshake by default. That
   * handshake fails CLOSED against a peer that cannot do it - including a
   * `@zafu/zid@0.1.0` peer, which speaks only the classical handshake - so pass
   * `{ channel: 'classical' }` to reach one, or `{ channel: 'auto' }` to accept an
   * automatic downgrade knowingly. There is no silent fallback.
   */
  async connect(opts: ZidOptions = {}): Promise<ZidIdentity> {
    const appOrigin = globalThis.location?.origin || opts.appName || 'unknown';

    if (!opts.ephemeral) {
      const zafu = await detectZafu();
      if (zafu) {
        // One request per app at a time: a second connect() while the wallet
        // is still asking the user JOINS the first instead of sending another
        // approval. Status goes waiting -> slow -> done | failed; nothing times
        // out on this side (see @zafu/interactions).
        let announced = false;
        return interaction(
          interactionKey('zid.connect', opts.appName ?? ''),
          () => connectWallet(zafu, opts, appOrigin),
          {
            slowAfterMs: opts.slowAfterMs,
            onStatus: status => {
              if (!announced && (status === 'waiting' || status === 'slow')) {
                announced = true;
                opts.onWaiting?.();
              }
              opts.onStatus?.(status);
            },
          },
        ).result;
      }
      if (opts.requireWallet) {
        throw new ZafuError('unavailable', 'no zafu wallet reachable');
      }
    }

    // ephemeral mode - no wallet: the guest identity derives its own keys,
    // contact card and hybrid channel from a seed (in-memory by default).
    return createGuestIdentity({
      origin: appOrigin,
      appName: opts.appName,
      relayUrl: opts.relayUrl,
      channel: opts.channel,
      persist: opts.persist,
      relayTransport: opts.relayTransport,
      relayEndpoint: opts.relayEndpoint,
      relayToken: opts.relayToken,
    });
  },

  /** set display name - per-app to prevent cross-app correlation */
  setName(name: string, appName?: string) {
    const key = appName ? `zid_name:${appName}` : 'zid_name';
    localStorage.setItem(key, name);
  },

  /** get stored display name for this app */
  getName(appName?: string): string | null {
    const key = appName ? `zid_name:${appName}` : 'zid_name';
    return localStorage.getItem(key);
  },

  /** add a contact (call when you interact with someone - auto-builds social graph) */
  addContact: upsertContact,

  /** get contacts for this app */
  async getContacts(appName?: string) {
    const origin = globalThis.location?.origin || appName || 'unknown';
    return getContactRefs(origin);
  },
};

/**
 * The wallet half of connect: a fresh session key, delegated by the wallet.
 * Throws a typed ZafuError when the wallet declines, is locked, or is
 * unreachable - never falls back to a guest identity.
 */
async function connectWallet(
  zafu: ZafuHandle,
  opts: ZidOptions,
  appOrigin: string,
): Promise<ZidIdentity> {
  const session = await createSessionKey();
  const delegation = await requestDelegation(zafu, session.pubkey, opts);
  const appKey = opts.appName ? `zid_name:${opts.appName}` : 'zid_name';
  const name =
    localStorage.getItem(appKey) ||
    localStorage.getItem('zid_name') ||
    delegation.walletPubkey.slice(0, 8);
  return {
    pubkey: session.pubkey,
    network: delegation.network,
    name,
    sign: session.sign,
    verify: session.verify,
    // the handshake is the caller's choice (opts.channel); 'hybrid' by default.
    channel: (peerPubkey: string) => openChannel(session, peerPubkey, opts.relayUrl, opts.channel),
    // sealFor/openSealed mirror encryptFor/decryptFrom so the call site is
    // identical to the guest's - only the backend (wallet vs local) differs.
    sealFor: async (recipient: string | AdvertisedKeys, bytes: Uint8Array) => {
      const r: ZidRecipient = typeof recipient === 'string' ? { pubkey: recipient } : recipient;
      const out = await encryptFor(zafu, r, bytes);
      return {
        ciphertext: base64ToBytes(out.ciphertext),
        ephemeral_pubkey:
          out.ephemeral_pubkey === '' ? new Uint8Array(0) : hexToBytes(out.ephemeral_pubkey),
        postQuantum: out.postQuantum,
        ...(out.pq_epoch !== undefined ? { pq_epoch: out.pq_epoch } : {}),
      };
    },
    openSealed: async sealed =>
      decryptFrom(zafu, {
        ciphertext: bytesToBase64(sealed.ciphertext),
        ephemeral_pubkey:
          sealed.ephemeral_pubkey.length === 0 ? '' : bytesToHex(sealed.ephemeral_pubkey),
        ...(sealed.pq_epoch !== undefined ? { pq_epoch: sealed.pq_epoch } : {}),
      }),
    pickContacts: async (pickOpts?: PickContactsOptions) => {
      // try zafu wallet picker first
      const result = await providerPickContacts(zafu, {
        ...pickOpts,
        appName: opts.appName,
      });
      if (result && result.length > 0) {
        return result;
      }
      // fallback to zid local contacts
      return getContactRefs(appOrigin);
    },
    invite: async (handle: string, payload: InvitePayload) => {
      // try zafu-routed invite first (e2ee via wallet)
      const result = await sendInvite(zafu, handle, payload, {
        appName: opts.appName,
        relayUrl: opts.relayUrl,
      });
      if (result.sent) {
        return result;
      }
      // fallback: resolve handle locally and send via zid channel. Invites
      // keep the classical channel: the handle gives only a bare pubkey and
      // the receiver is an app-level listener, not channel().
      const pubkey = resolveHandle(handle, appOrigin);
      if (pubkey) {
        const ch = await createChannel(session, pubkey, opts.relayUrl);
        ch.send(JSON.stringify({ type: 'zid:invite', payload, from: name, appOrigin }));
        // don't close channel immediately - recipient needs time to receive
        setTimeout(() => ch.close(), 30_000);
        return { sent: true };
      }
      return { sent: false };
    },
    onInvite: (handler: (invite: IncomingInvite) => void) => {
      return listenInvites(zafu, handler);
    },
    mode: 'zafu',
    walletPubkey: delegation.walletPubkey,
    delegation: delegation.signature,
    disconnect: () => {
      /* clear session */
    },
  };
}
