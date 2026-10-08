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
  /** the founder answers a joiner: its message, tag and verify words, rebuilt from the run's seed */
  | { step: 'answer'; words: string; session: string; seed: string; y: string }
  /** a joiner reads an answer: the key, words and its own tag when the founder's holds, null when the words differ */
  | { step: 'finish'; words: string; session: string; seed: string; x: string; tag: string }
  /** the founder reads a joiner's tag: the run's key when it holds, null when it does not */
  | { step: 'admit'; words: string; session: string; seed: string; y: string; tag: string };

export interface DoorAnswer {
  x: string;
  tag: string;
  words: string;
}

export interface DoorFinish {
  key: string;
  words: string;
  /** the joiner's confirmation, said back as `wk` */
  tag: string;
}

export const doorPake = (
  w: DoorPakeWasm,
  a: DoorPakeCall,
): string | DoorAnswer | DoorFinish | null => {
  const session = hexToBytes(a.session);
  const seed = hexToBytes(a.seed);
  if (a.step === 'speak') {
    return bytesToHex(w.door_pake_message(false, a.words, session, seed));
  }
  if (a.step === 'answer' || a.step === 'admit') {
    const y = hexToBytes(a.y);
    let key: Uint8Array;
    try {
      key = w.door_pake_finish(true, a.words, session, seed, y);
    } catch {
      return null;
    }
    if (a.step === 'admit') {
      return w.door_pake_check(key, y, hexToBytes(a.tag)) ? bytesToHex(key) : null;
    }
    const x = w.door_pake_message(true, a.words, session, seed);
    return {
      x: bytesToHex(x),
      tag: bytesToHex(w.door_pake_confirm(key, x)),
      words: w.door_pake_verify_words(key),
    };
  }
  const x = hexToBytes(a.x);
  let key: Uint8Array;
  try {
    key = w.door_pake_finish(false, a.words, session, seed, x);
  } catch {
    return null;
  }
  if (!w.door_pake_check(key, x, hexToBytes(a.tag))) {
    return null;
  }
  const y = w.door_pake_message(false, a.words, session, seed);
  return {
    key: bytesToHex(key),
    words: w.door_pake_verify_words(key),
    tag: bytesToHex(w.door_pake_confirm(key, y)),
  };
};
