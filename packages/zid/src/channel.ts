/**
 * e2ee channel between two zid identities
 *
 * x25519 ECDH key exchange → AES-256-GCM encrypted messages
 * relay-agnostic: works over WebSocket, WebRTC, or any transport
 *
 * This is the CLASSICAL fallback, used only when the caller asks for it:
 * `zid.connect({ channel: 'classical' })` (or the fallback half of `'auto'`).
 * `openChannel` (./channel-select) is the one place that choice is made, and it
 * defaults to the hybrid post-quantum channel (./noise-channel).
 */

import { ZafuError } from './errors';
import type { ZidChannel } from './types';

interface SessionKey {
  pubkey: string;
  sign: (data: Uint8Array) => Promise<string>;
}

/** how long a channel waits for the peer's `keyex` before queued sends are refused. */
const READY_DEADLINE_MS = 30_000;

/** cap on frames held before the session key exists; further sends are dropped. */
const MAX_PENDING_FRAMES = 64;

const enc = new TextEncoder();

/**
 * AEAD associated data binding the per-direction counter and both endpoints.
 * The counter makes a replayed `enc` frame fail to decrypt (and be rejected
 * before it reaches a handler); the direction stops a frame being reflected
 * back at its sender.
 */
function frameAad(from: string, to: string, counter: number): Uint8Array<ArrayBuffer> {
  return enc.encode(`zid-e2ee:${from}:${to}:${counter}`);
}

/** create an e2ee channel to a peer via relay WebSocket */
export async function createChannel(
  session: SessionKey,
  peerPubkey: string,
  relayUrl?: string,
): Promise<ZidChannel> {
  // generate ephemeral x25519 key pair for this channel
  const dh = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;

  const ourDhPub = new Uint8Array(await crypto.subtle.exportKey('raw', dh.publicKey));

  // sign our DH pubkey with our session key (authenticated key exchange)
  const dhSig = await session.sign(ourDhPub);

  // message handlers
  const handlers: ((data: Uint8Array) => void)[] = [];
  let sharedKey: CryptoKey | null = null;
  let ws: WebSocket | null = null;
  let closed = false;

  // -- readiness + pre-key send queue ---------------------------------------
  // The session key only exists after the peer's `keyex`. A caller that sends
  // immediately (an invite, say) must not have the frame silently dropped, so
  // frames are QUEUED here and flushed once the key is up. `ready` settles once
  // that flush has been handed to the transport, or rejects if the handshake
  // does not complete within the deadline.
  const pending: (string | Uint8Array)[] = [];
  let established = false;
  let readySettled = false;
  const {
    promise: ready,
    resolve: resolveReady,
    reject: rejectReady,
  } = Promise.withResolvers<void>();
  const settleReady = (error?: unknown): void => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    clearTimeout(readyTimer);
    if (error === undefined) {
      resolveReady();
    } else {
      rejectReady(error);
    }
  };
  // callers that never await `ready` must not trip an unhandled rejection
  ready.catch(() => {});
  const readyTimer = setTimeout(
    () => settleReady(new ZafuError('transport_error', 'zid: channel handshake timed out')),
    READY_DEADLINE_MS,
  );

  // outgoing frames are written in order, counting up per direction
  let sendCounter = 0;
  let lastRecvCounter = -1;
  let writeChain: Promise<void> = Promise.resolve();

  const toPlain = (data: string | Uint8Array): Uint8Array<ArrayBuffer> =>
    typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);

  const scheduleWrite = (data: string | Uint8Array): Promise<void> => {
    const run = writeChain.then(async () => {
      if (!sharedKey || !ws || closed) {
        return;
      }
      const counter = sendCounter++;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: frameAad(session.pubkey, peerPubkey, counter) },
          sharedKey,
          toPlain(data),
        ),
      );
      ws.send(
        JSON.stringify({
          type: 'enc',
          from: session.pubkey,
          to: peerPubkey,
          n: counter,
          iv: hex(iv),
          ct: hex(ct),
        }),
      );
    });
    writeChain = run.catch(() => {});
    return run;
  };

  // connect to relay
  const url =
    relayUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/zid`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    // send key exchange: our session pubkey + DH pubkey + signature
    ws?.send(
      JSON.stringify({
        type: 'keyex',
        from: session.pubkey,
        to: peerPubkey,
        dhPub: hex(ourDhPub),
        sig: dhSig,
      }),
    );
  };

  ws.onerror = () => settleReady(new ZafuError('transport_error', 'zid: channel socket error'));

  ws.onclose = () => {
    if (!established) {
      settleReady(new ZafuError('transport_error', 'zid: channel closed before key exchange'));
    }
  };

  ws.onmessage = async ev => {
    try {
      const msg = JSON.parse(ev.data);

      if (msg.type === 'keyex' && msg.from === peerPubkey) {
        // DEFECT B: never re-key a live channel. A replayed (or second) `keyex`
        // must not overwrite an established session key.
        if (established) {
          return;
        }
        // verify peer signed their DH pubkey with their session key (prevents relay MitM)
        const peerDhBytes = unhex(msg.dhPub);
        const peerSessionKey = await crypto.subtle.importKey(
          'raw',
          unhex(peerPubkey),
          'Ed25519',
          false,
          ['verify'],
        );
        const sigValid = await crypto.subtle.verify(
          'Ed25519',
          peerSessionKey,
          unhex(msg.sig),
          peerDhBytes,
        );
        if (!sigValid) {
          console.error('zid: DH signature verification failed - possible MitM');
          return;
        }

        // derive shared secret
        const peerDhPub = await crypto.subtle.importKey(
          'raw',
          peerDhBytes,
          { name: 'X25519' },
          false,
          [],
        );
        const sharedBits = new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: 'X25519', public: peerDhPub },
            dh.privateKey,
            256,
          ),
        );
        // derive AES key - info binds to both session pubkeys to prevent unknown-key-share
        const sortedPubkeys = [session.pubkey, peerPubkey].sort().join(':');
        const info = enc.encode(`zid-e2ee:${sortedPubkeys}`);
        const keyMaterial = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
          'deriveKey',
        ]);
        sharedKey = await crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        );
        established = true;

        // flush frames queued before the key existed, then confirm readiness
        const queued = pending.splice(0);
        for (const data of queued) {
          void scheduleWrite(data);
        }
        await writeChain;
        settleReady();
        return;
      }

      if (msg.type === 'enc' && msg.from === peerPubkey && sharedKey) {
        // DEFECT B: per-direction monotonic counter - a duplicate or old frame
        // (a replay) is dropped before it is decrypted or re-dispatched.
        const counter = msg.n;
        if (!Number.isInteger(counter) || counter <= lastRecvCounter) {
          return;
        }
        const iv = unhex(msg.iv);
        const ct = unhex(msg.ct);
        const plain = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, additionalData: frameAad(msg.from, session.pubkey, counter) },
            sharedKey,
            ct,
          ),
        );
        lastRecvCounter = counter;
        for (const h of handlers) {
          h(plain);
        }
      }
    } catch (e) {
      console.error('zid channel error:', e);
    }
  };

  return {
    peer: peerPubkey,

    ready,

    // send is fire-and-forget by the ZidChannel contract (void): before the key
    // exists the frame is queued and flushed on `keyex`.
    send: (data: string | Uint8Array) => {
      if (closed || !ws) {
        return;
      }
      if (!sharedKey) {
        // deadline already passed with no key: refuse rather than queue forever
        if (readySettled) {
          return;
        }
        if (pending.length < MAX_PENDING_FRAMES) {
          pending.push(data);
        }
        return;
      }
      void scheduleWrite(data);
    },

    on: (event: 'message', handler: (data: Uint8Array) => void) => {
      if (event === 'message') {
        handlers.push(handler);
      }
    },

    close: () => {
      closed = true;
      clearTimeout(readyTimer);
      ws?.close();
      ws = null;
      sharedKey = null;
      pending.length = 0;
    },
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
function unhex(h: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  }
  return bytes;
}
