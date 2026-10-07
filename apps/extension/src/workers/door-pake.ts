/**
 * A door's SPAKE2 steps (people/door) on zafu-wasm, one call each, run in the
 * zcash worker so the words, seeds and run keys only cross the message bus
 * sealed (see network-worker secretCall). Plain functions of the wasm module,
 * so a test can run them on the shipped blob.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export interface DoorPakeWasm {
  door_pake_message(host: boolean, code: string, session: Uint8Array, seed: Uint8Array): Uint8Array;
  door_pake_finish(
    host: boolean,
    code: string,
    session: Uint8Array,
    seed: Uint8Array,
    peer: Uint8Array,
  ): Uint8Array;
  door_pake_confirm(key: Uint8Array, ownMsg: Uint8Array): Uint8Array;
  door_pake_check(key: Uint8Array, peerMsg: Uint8Array, tag: Uint8Array): boolean;
  door_pake_verify_words(key: Uint8Array): string;
}

export type DoorPakeCall =
  /** a joiner's message for one run, rebuilt from its seed */
  | { step: 'speak'; words: string; session: string; seed: string }
  /** the founder answers a joiner: a fresh run, its message, tag, key and verify words */
  | { step: 'answer'; words: string; session: string; y: string }
  /** a joiner reads an answer: the key and words when the tag holds, null when the words differ */
  | { step: 'finish'; words: string; session: string; seed: string; x: string; tag: string };

export interface DoorAnswer {
  x: string;
  tag: string;
  key: string;
  words: string;
}

export const doorPake = (
  w: DoorPakeWasm,
  a: DoorPakeCall,
): string | DoorAnswer | { key: string; words: string } | null => {
  const session = hexToBytes(a.session);
  if (a.step === 'speak') {
    return bytesToHex(w.door_pake_message(false, a.words, session, hexToBytes(a.seed)));
  }
  if (a.step === 'answer') {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const x = w.door_pake_message(true, a.words, session, seed);
    const key = w.door_pake_finish(true, a.words, session, seed, hexToBytes(a.y));
    seed.fill(0);
    return {
      x: bytesToHex(x),
      tag: bytesToHex(w.door_pake_confirm(key, x)),
      key: bytesToHex(key),
      words: w.door_pake_verify_words(key),
    };
  }
  const x = hexToBytes(a.x);
  let key: Uint8Array;
  try {
    key = w.door_pake_finish(false, a.words, session, hexToBytes(a.seed), x);
  } catch {
    return null;
  }
  return w.door_pake_check(key, x, hexToBytes(a.tag))
    ? { key: bytesToHex(key), words: w.door_pake_verify_words(key) }
    : null;
};
