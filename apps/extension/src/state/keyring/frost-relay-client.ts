/**
 * frost relay client - WebSocket transport via poker-relay
 *
 * uses the poker-relay protocol (create/join/msg/part) for FROST
 * room coordination. rooms are ephemeral - auto-expire after TTL.
 * replaces the old gRPC/zidecar transport.
 */

// -- types --

export interface FrostRoom {
  roomCode: string;
  expiresAt: number;
}

export interface FrostParticipant {
  participantId: Uint8Array;
  participantCount: number;
  maxSigners: number;
}

export interface FrostMessage {
  senderId: Uint8Array;
  payload: Uint8Array;
  sequence: number;
}

export type RoomEvent =
  | { type: 'joined'; participant: FrostParticipant }
  | { type: 'message'; message: FrostMessage }
  | { type: 'closed'; reason: string };

// -- client --

export class FrostRelayClient {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private nick: string;
  private room: string | null = null;
  private joined = false;
  private onEvent: ((event: RoomEvent) => void) | null = null;
  private pendingEvents: RoomEvent[] = [];
  /** one-shot waiters consumed by createRoom/joinRoom handshakes */
  private waiters: Array<(msg: Record<string, unknown>) => boolean> = [];

  constructor(serverUrl: string) {
    // accept either https:// or wss:// — normalize to wss
    const url = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    this.wsUrl = url.includes('/ws') ? url : `${url}/ws`;
    // random nick - relay only sees this opaque string
    this.nick = 'f' + [...crypto.getRandomValues(new Uint8Array(4))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /** open WebSocket if not already connected */
  private connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error('frost relay: connection failed'));
      ws.onclose = () => { this.ws = null; this.joined = false; };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
          // resolve any handshake waiters matching this message, then still
          // dispatch as a normal event. previously we `return`-ed after
          // resolving a waiter, which swallowed the joiner's own `joined`
          // event and left participantCount stuck at 0 in the UI.
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            if (this.waiters[i]!(msg)) this.waiters.splice(i, 1);
          }
          this.dispatch(msg);
        } catch { /* malformed message */ }
      };
    });
  }

  /** route incoming relay messages to event handler */
  private dispatch(msg: Record<string, unknown>) {
    const t = msg['t'] as string;

    if (t === 'msg' && msg['nick'] !== this.nick) {
      const event: RoomEvent = {
        type: 'message',
        message: {
          senderId: new TextEncoder().encode(msg['nick'] as string),
          payload: new TextEncoder().encode((msg['text'] as string) || ''),
          sequence: 0,
        },
      };
      if (this.onEvent) this.onEvent(event);
      else this.pendingEvents.push(event);
    } else if (t === 'joined') {
      // structured join event from the relay (sent both to the joiner and as
      // `system` text to existing participants).
      const count = typeof msg['count'] === 'number' ? msg['count'] as number : 0;
      const event: RoomEvent = {
        type: 'joined',
        participant: {
          participantId: new Uint8Array(0),
          participantCount: count,
          maxSigners: 0,
        },
      };
      if (this.onEvent) this.onEvent(event);
      else this.pendingEvents.push(event);
    } else if (t === 'system') {
      // existing participants receive a system text "abc1... joined (N)"
      // when a peer joins. parse N out of the trailing parenthesized count.
      const text = (msg['text'] as string) || '';
      if (text.includes('joined')) {
        const match = text.match(/\((\d+)\)/);
        const event: RoomEvent = {
          type: 'joined',
          participant: {
            participantId: new Uint8Array(0),
            participantCount: match ? Number(match[1]) : 0,
            maxSigners: 0,
          },
        };
        if (this.onEvent) this.onEvent(event);
        else this.pendingEvents.push(event);
      } else if (text.includes('left') || text.includes('disconnected') || text.includes('closed')) {
        const event: RoomEvent = { type: 'closed', reason: text };
        if (this.onEvent) this.onEvent(event);
        else this.pendingEvents.push(event);
      }
    } else if (t === 'error') {
      const event: RoomEvent = { type: 'closed', reason: (msg['msg'] as string) || 'relay error' };
      if (this.onEvent) this.onEvent(event);
      else this.pendingEvents.push(event);
    }
  }

  /** wait for a specific relay message type */
  private waitFor<T>(predicate: (msg: Record<string, unknown>) => T | false): Promise<T> {
    return new Promise((resolve) => {
      this.waiters.push((msg) => {
        const result = predicate(msg);
        if (result !== false) { resolve(result as T); return true; }
        return false;
      });
    });
  }

  /** create a new FROST room. returns human-readable code like "acid-blue-cave" */
  async createRoom(_threshold: number, _maxSigners: number, ttlSeconds = 0): Promise<FrostRoom> {
    await this.connect();

    // wait for 'created' response
    const roomP = this.waitFor((msg) =>
      msg['t'] === 'created' ? (msg['room'] as string) : false,
    );
    this.ws!.send(JSON.stringify({ t: 'create', nick: this.nick }));
    const roomCode = await roomP;

    // auto-join the room
    const joinP = this.waitFor((msg) =>
      msg['t'] === 'joined' ? true : false,
    );
    this.ws!.send(JSON.stringify({ t: 'join', room: roomCode, nick: this.nick }));
    await joinP;

    this.room = roomCode;
    this.joined = true;

    return {
      roomCode,
      expiresAt: Math.floor(Date.now() / 1000) + (ttlSeconds || 3600),
    };
  }

  /**
   * join a room and receive events.
   * if already joined (from createRoom), just wires up the event handler.
   * resolves when the signal is aborted or room closes.
   */
  async joinRoom(
    roomCode: string,
    _participantId: Uint8Array,
    onEvent: (event: RoomEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.onEvent = onEvent;

    // flush buffered events
    for (const ev of this.pendingEvents) onEvent(ev);
    this.pendingEvents = [];

    if (this.joined && this.room === roomCode) {
      // already joined from createRoom - wait for abort
      if (signal) {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { this.disconnect(); resolve(); });
        });
      }
      return;
    }

    // connect and join
    await this.connect();
    const joinP = this.waitFor((msg) =>
      msg['t'] === 'joined' ? true : false,
    );
    this.ws!.send(JSON.stringify({ t: 'join', room: roomCode, nick: this.nick }));
    await joinP;

    this.room = roomCode;
    this.joined = true;

    if (signal) {
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { this.disconnect(); resolve(); });
      });
    }
  }

  /** send a message to all room participants */
  async sendMessage(_roomCode: string, _senderId: Uint8Array, payload: Uint8Array): Promise<number> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('frost relay: not connected');
    }
    const text = new TextDecoder().decode(payload);
    this.ws.send(JSON.stringify({ t: 'msg', text }));
    return 0;
  }

  /** disconnect from relay */
  disconnect() {
    if (this.ws) {
      try { this.ws.send(JSON.stringify({ t: 'part' })); } catch { /* closing */ }
      this.ws.close();
      this.ws = null;
    }
    this.room = null;
    this.joined = false;
    this.onEvent = null;
    this.pendingEvents = [];
    this.waiters = [];
  }
}
