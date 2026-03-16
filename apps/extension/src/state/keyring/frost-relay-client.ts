/**
 * frost relay grpc-web client
 *
 * extends zidecar for FROST multisig room coordination.
 * uses same raw protobuf encoding pattern as zidecar-client.ts.
 * rooms are ephemeral — auto-expire after TTL.
 */

// ── types ──

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

// ── client ──

export class FrostRelayClient {
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  /** create a new FROST room. returns human-readable code like "acid-blue-cave" */
  async createRoom(threshold: number, maxSigners: number, ttlSeconds = 0): Promise<FrostRoom> {
    const msg = encodeCreateRoom(threshold, maxSigners, ttlSeconds);
    const resp = await this.grpcCall('CreateRoom', msg);
    return parseCreateRoomResponse(resp);
  }

  /** send a signed message to all room participants */
  async sendMessage(roomCode: string, senderId: Uint8Array, payload: Uint8Array): Promise<number> {
    const msg = encodeSendMessage(roomCode, senderId, payload);
    const resp = await this.grpcCall('SendMessage', msg);
    return parseSendMessageResponse(resp);
  }

  /**
   * join a room and receive events (streaming).
   * calls onEvent for each participant join, relayed message, or room close.
   * returns when the stream ends or room closes.
   */
  async joinRoom(
    roomCode: string,
    participantId: Uint8Array,
    onEvent: (event: RoomEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const msg = encodeJoinRoom(roomCode, participantId);
    const path = `${this.serverUrl}/frost_relay.v1.FrostRelay/JoinRoom`;

    const reqBody = grpcFrame(msg);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+proto',
        'Accept': 'application/grpc-web+proto',
        'x-grpc-web': '1',
      },
      body: reqBody as unknown as BodyInit,
    };
    if (signal) init.signal = signal;
    const resp = await fetch(path, init);

    if (!resp.ok) throw new Error(`FrostRelay JoinRoom: HTTP ${resp.status}`);
    if (!resp.body) throw new Error('FrostRelay JoinRoom: no response body');

    const reader = resp.body.getReader();
    let buffer = new Uint8Array(0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // append to buffer
        const newBuf = new Uint8Array(buffer.length + value.length);
        newBuf.set(buffer);
        newBuf.set(value, buffer.length);
        buffer = newBuf;

        // parse complete frames from buffer
        while (buffer.length >= 5) {
          const flags = buffer[0]!;
          const len = (buffer[1]! << 24) | (buffer[2]! << 16) | (buffer[3]! << 8) | buffer[4]!;

          if (buffer.length < 5 + len) break; // incomplete frame

          if (flags & 0x80) {
            // trailer frame — check for error
            const trailer = new TextDecoder().decode(buffer.subarray(5, 5 + len));
            const statusMatch = trailer.match(/grpc-status:\s*(\d+)/);
            if (statusMatch && statusMatch[1] !== '0') {
              const msgMatch = trailer.match(/grpc-message:\s*(.+)/);
              throw new Error(`FrostRelay: ${decodeURIComponent(msgMatch?.[1]?.trim() ?? `status ${statusMatch[1]}`)}`);
            }
            buffer = buffer.subarray(5 + len);
            return; // stream ended cleanly
          }

          // data frame — parse RoomEvent
          const frame = buffer.subarray(5, 5 + len);
          buffer = buffer.subarray(5 + len);

          const event = parseRoomEvent(frame);
          if (event) onEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async grpcCall(method: string, msg: Uint8Array): Promise<Uint8Array> {
    const path = `${this.serverUrl}/frost_relay.v1.FrostRelay/${method}`;
    const reqBody = grpcFrame(msg);

    const resp = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+proto',
        'Accept': 'application/grpc-web+proto',
        'x-grpc-web': '1',
      },
      body: reqBody as unknown as BodyInit,
    });

    if (!resp.ok) throw new Error(`FrostRelay ${method}: HTTP ${resp.status}`);

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length < 5) throw new Error(`FrostRelay ${method}: empty response`);

    if (buf[0]! & 0x80) {
      const trailerLen = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
      const trailer = new TextDecoder().decode(buf.subarray(5, 5 + trailerLen));
      const statusMatch = trailer.match(/grpc-status:\s*(\d+)/);
      if (statusMatch && statusMatch[1] !== '0') {
        const msgMatch = trailer.match(/grpc-message:\s*(.+)/);
        throw new Error(`FrostRelay ${method}: ${decodeURIComponent(msgMatch?.[1]?.trim() ?? `status ${statusMatch[1]}`)}`);
      }
      return new Uint8Array(0);
    }

    const len = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
    return buf.subarray(5, 5 + len);
  }
}

// ── protobuf encoding ──

function grpcFrame(msg: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + msg.length);
  frame[0] = 0;
  frame[1] = (msg.length >> 24) & 0xff;
  frame[2] = (msg.length >> 16) & 0xff;
  frame[3] = (msg.length >> 8) & 0xff;
  frame[4] = msg.length & 0xff;
  frame.set(msg, 5);
  return frame;
}

function encodeVarint(n: number): Uint8Array {
  const bytes: number[] = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return new Uint8Array(bytes);
}

function encodeField(fieldNumber: number, wireType: number, data: Uint8Array): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | wireType);
  const out = new Uint8Array(tag.length + data.length);
  out.set(tag);
  out.set(data, tag.length);
  return out;
}

function encodeBytes(fieldNumber: number, data: Uint8Array): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(data.length);
  const out = new Uint8Array(tag.length + len.length + data.length);
  out.set(tag);
  out.set(len, tag.length);
  out.set(data, tag.length + len.length);
  return out;
}

function encodeString(fieldNumber: number, s: string): Uint8Array {
  return encodeBytes(fieldNumber, new TextEncoder().encode(s));
}

function encodeUint32(fieldNumber: number, v: number): Uint8Array {
  return encodeField(fieldNumber, 0, encodeVarint(v));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// CreateRoomRequest: threshold=1, max_signers=2, ttl_seconds=3
function encodeCreateRoom(threshold: number, maxSigners: number, ttlSeconds: number): Uint8Array {
  const parts = [encodeUint32(1, threshold), encodeUint32(2, maxSigners)];
  if (ttlSeconds > 0) parts.push(encodeUint32(3, ttlSeconds));
  return concat(...parts);
}

// JoinRoomRequest: room_code=1, participant_id=2
function encodeJoinRoom(roomCode: string, participantId: Uint8Array): Uint8Array {
  return concat(encodeString(1, roomCode), encodeBytes(2, participantId));
}

// SendMessageRequest: room_code=1, sender_id=2, payload=3
function encodeSendMessage(roomCode: string, senderId: Uint8Array, payload: Uint8Array): Uint8Array {
  return concat(encodeString(1, roomCode), encodeBytes(2, senderId), encodeBytes(3, payload));
}

// ── protobuf decoding ──

function parseCreateRoomResponse(buf: Uint8Array): FrostRoom {
  let roomCode = '';
  let expiresAt = 0;
  let pos = 0;
  while (pos < buf.length) {
    const [tag, newPos] = readVarint(buf, pos);
    pos = newPos;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      if (field === 1) roomCode = new TextDecoder().decode(buf.subarray(pos, pos + len));
      pos += len;
    } else if (wire === 0) {
      const [val, p2] = readVarint(buf, pos);
      pos = p2;
      if (field === 2) expiresAt = val;
    } else break;
  }
  return { roomCode, expiresAt };
}

function parseSendMessageResponse(buf: Uint8Array): number {
  let sequence = 0;
  let pos = 0;
  while (pos < buf.length) {
    const [tag, newPos] = readVarint(buf, pos);
    pos = newPos;
    const wire = tag & 7;
    if (wire === 0) {
      const [val, p2] = readVarint(buf, pos);
      pos = p2;
      if ((tag >> 3) === 1) sequence = val;
    } else break;
  }
  return sequence;
}

function parseRoomEvent(buf: Uint8Array): RoomEvent | null {
  let pos = 0;
  while (pos < buf.length) {
    const [tag, newPos] = readVarint(buf, pos);
    pos = newPos;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire !== 2) {
      // skip varint
      if (wire === 0) { const [, p2] = readVarint(buf, pos); pos = p2; }
      continue;
    }
    const [len, p2] = readVarint(buf, pos);
    pos = p2;
    const data = buf.subarray(pos, pos + len);
    pos += len;

    if (field === 1) return { type: 'joined', participant: parseParticipantJoined(data) };
    if (field === 2) return { type: 'message', message: parseRelayedMessage(data) };
    if (field === 3) return { type: 'closed', reason: new TextDecoder().decode(data) };
  }
  return null;
}

function parseParticipantJoined(buf: Uint8Array): FrostParticipant {
  let participantId = new Uint8Array(0);
  let participantCount = 0;
  let maxSigners = 0;
  let pos = 0;
  while (pos < buf.length) {
    const [tag, newPos] = readVarint(buf, pos);
    pos = newPos;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      if (field === 1) participantId = buf.slice(pos, pos + len);
      pos += len;
    } else if (wire === 0) {
      const [val, p2] = readVarint(buf, pos);
      pos = p2;
      if (field === 2) participantCount = val;
      if (field === 3) maxSigners = val;
    } else break;
  }
  return { participantId, participantCount, maxSigners };
}

function parseRelayedMessage(buf: Uint8Array): FrostMessage {
  let senderId = new Uint8Array(0);
  let payload = new Uint8Array(0);
  let sequence = 0;
  let pos = 0;
  while (pos < buf.length) {
    const [tag, newPos] = readVarint(buf, pos);
    pos = newPos;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      if (field === 1) senderId = buf.slice(pos, pos + len);
      if (field === 2) payload = buf.slice(pos, pos + len);
      pos += len;
    } else if (wire === 0) {
      const [val, p2] = readVarint(buf, pos);
      pos = p2;
      if (field === 3) sequence = val;
    } else break;
  }
  return { senderId, payload, sequence };
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++]!;
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
  }
  return [result, pos];
}
