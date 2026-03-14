/**
 * WebRTC peer connection with ephemeral session authentication.
 *
 * Signaling flows through encrypted memos — the connection emits
 * `signal` events that the caller sends as memos, and accepts
 * remote signals via `handleSignal()`.
 *
 * Each side generates an ephemeral ECDH keypair (P-256). The public
 * key is included in the signaling envelope. After the DataChannel
 * opens, peers verify key ownership via a challenge-response:
 *
 *   1. Both sides send auth-challenge with a random nonce
 *   2. Each side signs the nonce with their ephemeral private key
 *   3. The signature is verified against the public key from the memo
 *
 * This proves the WebRTC peer is the same entity that sent the
 * signaling memo, without revealing any permanent wallet identity
 * in the WebRTC layer.
 */

import type {
  SignalEnvelope,
  PeerMessage,
  PeerState,
  PeerEvents,
} from './types';

const CHANNEL_LABEL = 'zafu';
const CHUNK_SIZE = 16 * 1024; // 16 KiB chunks for file transfer

export interface PeerConnectionOptions {
  /** STUN/TURN servers. Defaults to public Google STUN. */
  iceServers?: RTCIceServer[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventMap = Record<string, Set<(...args: any[]) => void>>;

/** Hex encode/decode helpers. */
const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) =>
  new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));

export class PeerConnection {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private _state: PeerState = 'idle';
  private _sessionId: string;
  private listeners: EventMap = {};

  // ephemeral session key (ECDSA P-256 for signing challenges)
  private ephemeralKey: CryptoKeyPair | null = null;
  private _ephemeralPubHex: string = '';
  private _remotePubHex: string = '';
  private _authenticated = false;

  constructor(opts?: PeerConnectionOptions) {
    this._sessionId = crypto.randomUUID();
    this.pc = new RTCPeerConnection({
      iceServers: opts?.iceServers ?? [
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    });

    // no trickle ICE — candidates are bundled into offer/answer SDP
    // so each signaling exchange is exactly 1 memo (1 RTT total)
    this.pc.onicecandidate = () => {};

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected' && !this._authenticated) {
        this.setState('authenticating');
      } else if (s === 'disconnected') {
        this.setState('disconnected');
      } else if (s === 'failed') {
        this.setState('failed');
      }
    };

    this.pc.ondatachannel = (e) => {
      this.setupDataChannel(e.channel);
    };
  }

  get state(): PeerState { return this._state; }
  get sessionId(): string { return this._sessionId; }
  get authenticated(): boolean { return this._authenticated; }
  get ephemeralPubHex(): string { return this._ephemeralPubHex; }

  /** Generate ephemeral session keypair. Called before createOffer/handleSignal. */
  async init(): Promise<void> {
    this.ephemeralKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,  // not extractable — never leaves this session
      ['sign', 'verify'],
    );
    const pubRaw = await crypto.subtle.exportKey('raw', this.ephemeralKey.publicKey);
    this._ephemeralPubHex = toHex(pubRaw);
  }

  /**
   * Initiate a connection (caller side).
   *
   * Waits for ICE gathering to complete so all candidates are bundled
   * into the SDP offer — exactly 1 memo, no trickle ICE.
   */
  async createOffer(): Promise<void> {
    if (!this.ephemeralKey) await this.init();
    this.setState('signaling');
    this.dc = this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    this.setupDataChannel(this.dc);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGathering();

    this.emit('signal', {
      __zafu_signal: true,
      sessionId: this._sessionId,
      type: 'offer',
      payload: JSON.stringify(this.pc.localDescription!.toJSON()),
      ephemeralPub: this._ephemeralPubHex,
    });
  }

  /** Handle a signaling message from the remote peer. */
  async handleSignal(envelope: SignalEnvelope): Promise<void> {
    if (!this.ephemeralKey) await this.init();

    // adopt the session ID from the initiator
    if (envelope.type === 'offer') {
      this._sessionId = envelope.sessionId;
    }

    if (envelope.sessionId !== this._sessionId) return;

    // capture remote ephemeral public key
    if (envelope.ephemeralPub) {
      this._remotePubHex = envelope.ephemeralPub;
    }

    switch (envelope.type) {
      case 'offer': {
        this.setState('signaling');
        const desc = JSON.parse(envelope.payload) as RTCSessionDescriptionInit;
        await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.waitForIceGathering();
        this.emit('signal', {
          __zafu_signal: true,
          sessionId: this._sessionId,
          type: 'answer',
          payload: JSON.stringify(this.pc.localDescription!.toJSON()),
          ephemeralPub: this._ephemeralPubHex,
        });
        this.setState('connecting');
        break;
      }

      case 'answer': {
        const desc = JSON.parse(envelope.payload) as RTCSessionDescriptionInit;
        await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
        this.setState('connecting');
        break;
      }

      case 'close':
        this.close();
        break;
    }
  }

  /** Send a typed message over the DataChannel. */
  send(msg: PeerMessage): void {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('data channel not open');
    }
    this.dc.send(JSON.stringify(msg));
  }

  /** Send a file in chunks. */
  async sendFile(
    file: File,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    if (!this._authenticated) throw new Error('not authenticated');
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('data channel not open');
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    this.send({
      type: 'file-offer',
      payload: {
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks,
      },
    });

    await new Promise(r => setTimeout(r, 100));

    const reader = file.stream().getReader();
    let sent = 0;
    let index = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
        const slice = value.subarray(offset, offset + CHUNK_SIZE);
        const b64 = btoa(String.fromCharCode(...slice));

        while (this.dc!.bufferedAmount > 1024 * 1024) {
          await new Promise(r => setTimeout(r, 50));
        }

        this.send({ type: 'file-chunk', payload: { index, data: b64 } });
        sent += slice.length;
        index++;
        onProgress?.(sent, file.size);
      }
    }

    this.send({ type: 'file-complete', payload: { totalChunks } });
  }

  /** Close the connection. */
  close(): void {
    if (this._state !== 'idle' && this._state !== 'disconnected') {
      try {
        this.emit('signal', {
          __zafu_signal: true,
          sessionId: this._sessionId,
          type: 'close',
          payload: '',
        });
      } catch { /* already closed */ }
    }
    this.dc?.close();
    this.pc.close();
    this._authenticated = false;
    this.setState('disconnected');
  }

  // --- events ---

  on<K extends keyof PeerEvents>(event: K, fn: PeerEvents[K]): void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event]!.add(fn as (...args: unknown[]) => void);
  }

  off<K extends keyof PeerEvents>(event: K, fn: PeerEvents[K]): void {
    this.listeners[event]?.delete(fn as (...args: unknown[]) => void);
  }

  private emit<K extends keyof PeerEvents>(
    event: K,
    ...args: Parameters<PeerEvents[K]>
  ): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of set) {
      fn(...args);
    }
  }

  /** Wait for ICE gathering to complete so all candidates are in the SDP. */
  private waitForIceGathering(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pc.removeEventListener('icegatheringstatechange', handler);
        // resolve anyway with whatever candidates we have
        resolve();
      }, 10_000);
      const handler = () => {
        if (this.pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          this.pc.removeEventListener('icegatheringstatechange', handler);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', handler);
    });
  }

  private setState(state: PeerState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit('stateChange', state);
  }

  /**
   * Ephemeral key authentication after DataChannel opens.
   *
   * Both sides exchange challenge-response:
   *   1. Send a random nonce
   *   2. Remote signs it with their ephemeral key
   *   3. We verify the signature against the pubkey from the memo
   *
   * This proves the WebRTC peer holds the ephemeral key that was
   * advertised in the encrypted signaling memo, without revealing
   * any permanent wallet key in the WebRTC layer.
   */
  private async authenticate(): Promise<void> {
    if (!this.ephemeralKey || !this._remotePubHex) {
      this.emit('error', new Error('missing ephemeral keys for auth'));
      this.setState('failed');
      return;
    }

    this.setState('authenticating');

    // import remote public key
    const remotePubKey = await crypto.subtle.importKey(
      'raw',
      fromHex(this._remotePubHex),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    // generate challenge nonce
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const challengeHex = toHex(challenge);

    return new Promise((resolve, reject) => {
      let sentChallenge = false;
      let verified = false;
      const timeout = setTimeout(() => {
        this.off('message', handler);
        reject(new Error('auth timeout'));
        this.setState('failed');
      }, 15_000);

      const handler = async (msg: PeerMessage) => {
        try {
          if (msg.type === 'auth-challenge') {
            // sign the remote challenge with our ephemeral key
            const remoteNonce = fromHex(msg.payload as string);
            const sig = await crypto.subtle.sign(
              { name: 'ECDSA', hash: 'SHA-256' },
              this.ephemeralKey!.privateKey,
              remoteNonce,
            );
            this.send({
              type: 'auth-response',
              payload: toHex(sig),
            });
          } else if (msg.type === 'auth-response') {
            // verify remote signature on our challenge
            const sigBytes = fromHex(msg.payload as string);
            const valid = await crypto.subtle.verify(
              { name: 'ECDSA', hash: 'SHA-256' },
              remotePubKey,
              sigBytes,
              challenge,
            );
            if (!valid) {
              clearTimeout(timeout);
              this.off('message', handler);
              this.emit('error', new Error('peer authentication failed'));
              this.setState('failed');
              reject(new Error('peer authentication failed'));
              return;
            }
            verified = true;
            if (sentChallenge) {
              clearTimeout(timeout);
              this.off('message', handler);
              this._authenticated = true;
              this.setState('connected');
              resolve();
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          this.off('message', handler);
          reject(err);
        }
      };

      this.on('message', handler);

      // send our challenge
      this.send({ type: 'auth-challenge', payload: challengeHex });
      sentChallenge = true;

      // if we already received and verified before sending, resolve now
      if (verified) {
        clearTimeout(timeout);
        this.off('message', handler);
        this._authenticated = true;
        this.setState('connected');
        resolve();
      }
    });
  }

  private setupDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      // start authentication handshake
      void this.authenticate().catch(err => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    };

    dc.onclose = () => {
      this._authenticated = false;
      this.setState('disconnected');
    };

    dc.onerror = (e) => {
      this.emit('error', new Error(`DataChannel error: ${(e as ErrorEvent).message ?? 'unknown'}`));
    };

    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as PeerMessage;
        this.emit('message', msg);
      } catch {
        this.emit('error', new Error('invalid peer message'));
      }
    };
  }
}
