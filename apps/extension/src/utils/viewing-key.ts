/**
 * Tell what a pasted string is before doing anything with it, so the screen
 * can say so in plain words - including the dangerous case where someone
 * pastes their seed phrase into a viewing-key field.
 *
 * Structural only (prefix / shape). The authoritative check is the wasm
 * `validate_ufvk` decode, run before anything is stored.
 */

export type ViewingKeyKind =
  | { kind: 'empty' }
  | { kind: 'ufvk'; mainnet: boolean; key: string }
  | { kind: 'uivk' } // incoming-only: cannot see what the wallet spends
  | { kind: 'sapling' } // legacy sapling viewing key
  | { kind: 'seed' } // a seed phrase: never belongs here
  | { kind: 'spending_key' } // a spending key: never belongs here either
  | { kind: 'unknown' };

export const classifyViewingKey = (input: string): ViewingKeyKind => {
  const raw = input.trim();
  if (!raw) {
    return { kind: 'empty' };
  }

  // 12 / 15 / 18 / 21 / 24 lowercase words: a seed phrase
  const words = raw.split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && words.every(w => /^[a-z]+$/.test(w))) {
    return { kind: 'seed' };
  }

  // keys carry no whitespace; tolerate line breaks from copy-paste
  const key = raw.replace(/\s+/g, '');
  const lower = key.toLowerCase();

  if (lower.startsWith('uviewtest1')) {
    return { kind: 'ufvk', mainnet: false, key };
  }
  if (lower.startsWith('uview1')) {
    return { kind: 'ufvk', mainnet: true, key };
  }
  if (lower.startsWith('uivk')) {
    return { kind: 'uivk' };
  }
  if (lower.startsWith('zxview') || lower.startsWith('zview')) {
    return { kind: 'sapling' };
  }
  if (
    lower.startsWith('secret-extended-key') ||
    lower.startsWith('usk') ||
    lower.startsWith('secret-orchard')
  ) {
    return { kind: 'spending_key' };
  }
  return { kind: 'unknown' };
};

/** Stable id for dedup: re-adding the same key finds the same wallet. */
export const viewingKeyDeviceId = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return `viewkey-${hex.slice(0, 16)}`;
};
