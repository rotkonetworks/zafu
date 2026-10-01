/**
 * Move everything sealed under one master key to another, for a password
 * change. Pure: takes a raw chrome.storage.local snapshot, returns only the
 * entries that changed, and writes nothing.
 *
 * It does not keep a list of where secrets live. Every Box it meets - a
 * stored object, a JSON string holding one (vault.encryptedData, voting
 * boxes), or one nested inside another box's JSON plaintext (the
 * `{ encrypted }` wrappers around penumbraWallets / zcashWallets, whose
 * records carry seed and FROST share boxes of their own) - is tried with the
 * old key. AES-GCM only opens what that key sealed, so whatever opens is
 * ours and moves; whatever does not was never under this password and is
 * left as it is. A store added later moves without anyone remembering to
 * add it here, which is the bug this replaces: the old re-seal knew two
 * stores and orphaned the rest.
 *
 * Each new box is opened again with the new key before it is returned, so a
 * snapshot only comes back if every ciphertext in it verifies.
 */

import { Box, type BoxJson } from '@repo/encryption/box';
import type { Key } from '@repo/encryption/key';

const isBox = (v: object): v is BoxJson =>
  typeof (v as BoxJson).nonce === 'string' &&
  typeof (v as BoxJson).cipherText === 'string' &&
  Object.keys(v).length === 2;

const open = (key: Key, box: BoxJson): Promise<string | null> =>
  Promise.resolve()
    .then(() => key.unseal(Box.fromJson(box)))
    .catch(() => null);

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export const resealSnapshot = async (
  raw: Record<string, unknown>,
  from: Key,
  to: Key,
): Promise<Record<string, unknown>> => {
  const seal = async (plain: string): Promise<BoxJson> => {
    const box = (await to.seal(plain)).toJson();
    if ((await open(to, box)) !== plain) {
      throw new Error('a re-sealed secret did not open with the new key');
    }
    return box;
  };

  // returns the same reference when nothing inside moved
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string') {
      if (!v.startsWith('{"nonce"')) {
        return v;
      }
      const parsed = parseJson(v);
      const moved = parsed === undefined ? parsed : await walk(parsed);
      return moved === parsed ? v : JSON.stringify(moved);
    }
    if (Array.isArray(v)) {
      const out = await Promise.all(v.map(walk));
      return out.some((x, i) => x !== v[i]) ? out : v;
    }
    if (!v || typeof v !== 'object') {
      return v;
    }
    if (isBox(v)) {
      const plain = await open(from, v);
      if (plain === null) {
        return v;
      }
      const inner = parseJson(plain);
      const movedInner = inner && typeof inner === 'object' ? await walk(inner) : inner;
      return seal(movedInner === inner ? plain : JSON.stringify(movedInner));
    }
    const entries = Object.entries(v);
    const out = await Promise.all(entries.map(([, x]) => walk(x)));
    return out.some((x, i) => x !== entries[i]![1])
      ? Object.fromEntries(entries.map(([k], i) => [k, out[i]]))
      : v;
  };

  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const moved = await walk(v);
    if (moved !== v) {
      patch[k] = moved;
    }
  }
  return patch;
};
