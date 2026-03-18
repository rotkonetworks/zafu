/**
 * Transport service for the message pipeline.
 *
 * Pluggable: WebSocket, gRPC-web, iroh, or mock (for testing).
 * The transport doesn't know what it's carrying — just bytes in, bytes out.
 *
 * Service[SendReq, void] for outgoing.
 * Callbacks for incoming (push-based, like WebSocket/gRPC streams).
 */

import type { Service } from '../types';
import type { ChatMessage } from './encrypt';

/** Transport provider interface. */
export interface TransportProvider {
  /** connect to the relay */
  connect(): Promise<void>;
  /** disconnect */
  disconnect(): void;
  /** send a message (join, msg, create, part) */
  send(msg: Record<string, unknown>): void;
  /** register incoming message handler */
  onMessage(handler: (msg: ChatMessage | SystemMessage) => void): void;
  /** register connection state handler */
  onStateChange(handler: (connected: boolean) => void): void;
  /** current connection state */
  connected: boolean;
  /** provider name */
  name: string;
}

/** System messages from the relay (joins, leaves, errors). */
export interface SystemMessage {
  type: 'system' | 'error' | 'joined' | 'left' | 'created';
  text: string;
  room?: string;
  count?: number;
}

/** WebSocket transport to relay.zk.bot. */
export class WebSocketTransport implements TransportProvider {
  name = 'websocket';
  connected = false;
  private ws: WebSocket | null = null;
  private msgHandler: ((msg: ChatMessage | SystemMessage) => void) | null = null;
  private stateHandler: ((connected: boolean) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }

      this.ws.onopen = () => {
        this.connected = true;
        this.stateHandler?.(true);
        resolve();
      };

      this.ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          switch (data.t) {
            case 'msg':
              this.msgHandler?.({ nick: data.nick, text: data.text, type: 'msg', ts: data.ts, seq: data.seq });
              break;
            case 'joined':
              this.msgHandler?.({ type: 'joined', text: `joined #${data.room} (${data.count} users)`, room: data.room, count: data.count });
              break;
            case 'created':
              this.msgHandler?.({ type: 'created', text: `room created: ${data.room}`, room: data.room });
              break;
            case 'left':
              this.msgHandler?.({ type: 'left', text: `${data.nick} left (${data.count})`, count: data.count });
              break;
            case 'system':
              this.msgHandler?.({ type: 'system', text: data.text });
              break;
            case 'error':
              this.msgHandler?.({ type: 'error', text: data.msg });
              break;
          }
        } catch { /* ignore */ }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.stateHandler?.(false);
        // auto-reconnect
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      };

      this.ws.onerror = () => {
        reject(new Error('websocket error'));
      };
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: (msg: ChatMessage | SystemMessage) => void): void {
    this.msgHandler = handler;
  }

  onStateChange(handler: (connected: boolean) => void): void {
    this.stateHandler = handler;
  }
}

/**
 * Nym mixnet transport (stub).
 *
 * Uses @nymproject/sdk WebSocket client to route through the Nym mixnet.
 * The relay receives messages from a Nym exit node, not your IP.
 * Adds ~200-500ms latency per message.
 *
 * Requires: relay runs a Nym service provider (SPK address).
 */
export class NymTransport implements TransportProvider {
  name = 'nym';
  connected = false;
  constructor(private _relayNymAddress: string) {}

  async connect(): Promise<void> {
    // TODO: import @nymproject/sdk
    // const client = await createNymMixnetClient();
    // await client.connect({ nymApiUrl, preferredGateway });
    throw new Error('nym transport not yet implemented — install @nymproject/sdk');
  }
  disconnect(): void { this.connected = false; }
  send(_msg: Record<string, unknown>): void { /* TODO */ }
  onMessage(_handler: (msg: ChatMessage | SystemMessage) => void): void { /* TODO */ }
  onStateChange(_handler: (connected: boolean) => void): void { /* TODO */ }
}

/**
 * I2P transport (stub).
 *
 * Routes through the I2P network via SAM bridge.
 * The relay has an I2P tunnel (.b32.i2p address).
 * Garlic routing provides sender anonymity.
 *
 * Requires: user runs an I2P router locally, relay has I2P tunnel.
 */
export class I2PTransport implements TransportProvider {
  name = 'i2p';
  connected = false;
  constructor(private _relayI2PDest: string) {}

  async connect(): Promise<void> {
    // TODO: connect to local I2P SAM bridge (port 7656)
    // then create a streaming connection to the relay's I2P destination
    throw new Error('i2p transport not yet implemented — requires local I2P router');
  }
  disconnect(): void { this.connected = false; }
  send(_msg: Record<string, unknown>): void { /* TODO */ }
  onMessage(_handler: (msg: ChatMessage | SystemMessage) => void): void { /* TODO */ }
  onStateChange(_handler: (connected: boolean) => void): void { /* TODO */ }
}

/** Available transport types. */
export type TransportType = 'websocket' | 'nym' | 'i2p';

/** Create a transport by type. */
export function createTransport(type: TransportType, relayUrl: string): TransportProvider {
  switch (type) {
    case 'websocket': return new WebSocketTransport(relayUrl);
    case 'nym': return new NymTransport(relayUrl);
    case 'i2p': return new I2PTransport(relayUrl);
  }
}

/**
 * Create a send service from a transport provider.
 * Service[ChatMessage, void] — sends a message through the transport.
 */
export function transportSendService(
  transport: TransportProvider,
  currentRoom: () => string | null,
): Service<ChatMessage, void> {
  return async (msg: ChatMessage) => {
    const room = msg.room || currentRoom();
    if (!room) throw new Error('not in a room');
    transport.send({ t: 'msg', text: msg.text });
  };
}
