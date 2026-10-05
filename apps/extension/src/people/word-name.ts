/**
 * A name made from a room key: two quiet words ("still river"), so a member
 * nobody has named reads as a person, not as hex.
 *
 * It derives only from the member's key in THIS room, and a room key is
 * derived per group (gen, G), so the same person has an unrelated name in
 * every group: nothing links them across rooms. 128 x 128 words, 14 bits; a
 * room where two members share one is told apart by `distinct`.
 */

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';

// prettier-ignore
const FIRST = [
  'quiet', 'still', 'calm', 'gentle', 'soft', 'slow', 'clear', 'bright',
  'pale', 'deep', 'warm', 'cool', 'early', 'late', 'young', 'old',
  'misty', 'snowy', 'sunny', 'rainy', 'windy', 'cloudy', 'starry', 'dusky',
  'amber', 'golden', 'silver', 'copper', 'ivory', 'jade', 'coral', 'pearl',
  'green', 'blue', 'grey', 'red', 'white', 'violet', 'russet', 'ochre',
  'hidden', 'distant', 'open', 'small', 'tall', 'wide', 'round', 'narrow',
  'patient', 'steady', 'humble', 'kind', 'brave', 'honest', 'modest', 'loyal',
  'merry', 'lucky', 'tidy', 'nimble', 'swift', 'light', 'level', 'simple',
  'dewy', 'summer', 'autumn', 'winter', 'morning', 'evening', 'midday', 'twilight',
  'mossy', 'leafy', 'sandy', 'stony', 'grassy', 'ferny', 'piney', 'reedy',
  'wild', 'fair', 'fresh', 'crisp', 'mild', 'faint', 'hushed', 'low',
  'high', 'north', 'south', 'east', 'west', 'inner', 'outer', 'upper',
  'lunar', 'solar', 'polar', 'coastal', 'rustic', 'urban', 'lone', 'twin',
  'first', 'final', 'second', 'third', 'tiny', 'grand', 'noble', 'plain',
  'sweet', 'salty', 'sharp', 'smooth', 'velvet', 'woolen', 'paper', 'glass',
  'ink', 'tea', 'rice', 'silk', 'hazel', 'ashen', 'linen', 'bamboo',
];

// prettier-ignore
const SECOND = [
  'river', 'stone', 'pine', 'cloud', 'brook', 'field', 'meadow', 'forest',
  'valley', 'hill', 'ridge', 'peak', 'shore', 'harbor', 'island', 'lake',
  'pond', 'spring', 'well', 'creek', 'delta', 'dune', 'cliff', 'cove',
  'bay', 'reef', 'tide', 'wave', 'rain', 'snow', 'frost', 'mist',
  'wind', 'breeze', 'storm', 'dawn', 'dusk', 'moon', 'star', 'comet',
  'sun', 'sky', 'ember', 'flame', 'lantern', 'candle', 'bell', 'drum',
  'flute', 'harp', 'kite', 'sail', 'boat', 'raft', 'bridge', 'gate',
  'path', 'road', 'trail', 'garden', 'orchard', 'grove', 'willow', 'birch',
  'oak', 'cedar', 'maple', 'plum', 'cherry', 'peach', 'lotus', 'iris',
  'lily', 'fern', 'moss', 'reed', 'clover', 'thistle', 'heron', 'crane',
  'swan', 'sparrow', 'robin', 'wren', 'finch', 'owl', 'hawk', 'falcon',
  'fox', 'hare', 'deer', 'otter', 'badger', 'bear', 'wolf', 'lynx',
  'koi', 'carp', 'trout', 'salmon', 'turtle', 'frog', 'cricket', 'moth',
  'pebble', 'shell', 'feather', 'leaf', 'seed', 'root', 'branch', 'petal',
  'teapot', 'bowl', 'cup', 'brush', 'scroll', 'fan', 'mirror', 'lamp',
  'temple', 'shrine', 'tower', 'cabin', 'hut', 'mill', 'barn', 'inn',
];

const TAG = new TextEncoder().encode('zafu-room-word-name-v1');

/** two words from a room pubkey (hex), the same on every device */
export const wordName = (pubkey: string): string => {
  let key: Uint8Array;
  try {
    key = hexToBytes(pubkey);
  } catch {
    key = new TextEncoder().encode(pubkey);
  }
  const msg = new Uint8Array(TAG.length + key.length);
  msg.set(TAG);
  msg.set(key, TAG.length);
  const h = sha256(msg);
  return `${FIRST[h[0]! & 0x7f]} ${SECOND[h[1]! & 0x7f]}`;
};

/** a name someone chose for themselves: one line, at most 24, no control characters */
export const cleanName = (raw: string | undefined): string =>
  (raw ?? '')
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, 24);

/** the hex default an older zafu gave everyone: not a name anyone chose */
const HEX_DEFAULT = /^[0-9a-f]{8}$/;

/**
 * How a member is called, best first: the name you saved for them as a
 * contact, the name they chose in this room, then their word name.
 */
export const memberName = (key: string, chosen?: string, saved?: string): string => {
  const own = cleanName(chosen);
  return cleanName(saved) || (own && !HEX_DEFAULT.test(own) ? own : wordName(key));
};

/**
 * Names as a list shows them: two members who would read the same get a
 * short tail from their key, so nobody is mistaken for someone else.
 */
export const distinct = (named: { key: string; name: string }[]): Map<string, string> => {
  const count = new Map<string, number>();
  for (const n of named) {
    count.set(n.name, (count.get(n.name) ?? 0) + 1);
  }
  return new Map(
    named.map(n => [
      n.key,
      (count.get(n.name) ?? 0) > 1 ? `${n.name} · ${n.key.slice(0, 4)}` : n.name,
    ]),
  );
};
