/**
 * rendezvous-client — human room codes in front of frostd sessions.
 *
 * zidecar's frostd listener also serves /rendezvous/*: a discovery room,
 * addressed by SHA-256 of a human code, where participants drop their relay
 * public keys and the coordinator later announces the frostd session uuid.
 * This restores the old three-word-code UX without restoring its hole:
 * knowing the code lets you OFFER a key, but only the coordinator's explicit
 * approval puts it in the frostd session, and frostd admits nobody else.
 *
 * The code is four bip39 words (~44 bits) against the old three-of-256
 * (~24 bits), and the server never sees it — only its hash.
 *
 * Stock frostd relays don't have these routes; `hasRendezvous` probes so the
 * UI can fall back to the manual key-exchange + session-id flow.
 */

import { wordlists } from 'bip39';

export interface RendezvousEntry {
  pubkey: string;
  note: string;
}

export interface RoomView {
  entries: RendezvousEntry[];
  sessionId: string | null;
}

const WORDS: string[] = wordlists['EN'] ?? [];

/** Four random bip39 words, dash-joined: the thing you send your co-signers. */
export function generateRoomCode(): string {
  if (WORDS.length !== 2048) {
    throw new Error('bip39 EN wordlist unavailable');
  }
  const idx = new Uint16Array(4);
  crypto.getRandomValues(idx);
  return Array.from(idx, i => WORDS[i % 2048]!).join('-');
}

/**
 * Room id = SHA-256 of the normalized code, hex. Normalization forgives the
 * ways a code mutates in a chat message: case, separators, stray whitespace.
 */
export async function roomIdFromCode(code: string): Promise<string> {
  const normalized = code.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function post(relayUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${relayUrl.replace(/\/$/, '')}/rendezvous/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Does this relay serve the rendezvous at all? Stock frostd 404s it. */
export async function hasRendezvous(relayUrl: string): Promise<boolean> {
  try {
    const res = await post(relayUrl, 'poll', { room: '0'.repeat(64) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Put our relay pubkey in the room. The first publish creates the room and
 * returns the creator token the coordinator needs for `announceSession`;
 * everyone else gets null.
 */
export async function publishKey(
  relayUrl: string,
  roomId: string,
  pubkey: string,
  note = '',
): Promise<string | null> {
  const res = await post(relayUrl, 'publish', { room: roomId, pubkey, note });
  if (!res.ok) {
    throw new Error(`rendezvous publish failed: ${res.status}`);
  }
  const body = (await res.json()) as { creator_token?: string };
  return body.creator_token ?? null;
}

export async function pollRoom(relayUrl: string, roomId: string): Promise<RoomView> {
  const res = await post(relayUrl, 'poll', { room: roomId });
  if (!res.ok) {
    throw new Error(`rendezvous poll failed: ${res.status}`);
  }
  const body = (await res.json()) as { entries: RendezvousEntry[]; session_id: string | null };
  return { entries: body.entries, sessionId: body.session_id };
}

/** Coordinator only: point the room's joiners at the created frostd session. */
export async function announceSession(
  relayUrl: string,
  roomId: string,
  creatorToken: string,
  sessionId: string,
): Promise<void> {
  const res = await post(relayUrl, 'announce', {
    room: roomId,
    creator_token: creatorToken,
    session_id: sessionId,
  });
  if (!res.ok) {
    throw new Error(`rendezvous announce failed: ${res.status}`);
  }
}
