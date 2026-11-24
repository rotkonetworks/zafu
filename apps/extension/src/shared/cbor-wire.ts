/**
 * Bytes that must cross the extension message bus. chrome.runtime.sendMessage
 * serializes as JSON, so a Uint8Array arrives as a plain object (`{"0":83,…}`)
 * and wasm then encodes zero bytes: `ur:zigner-module/aeaeaeae`. Carry them as
 * hex, and revive a Uint8Array on receipt.
 */

export const bytesToHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
};

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('invalid hex: odd length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('invalid hex: non-hex characters');
    }
    out[i] = byte;
  }
  return out;
};

const isByte = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255;

/** Recover bytes from hex, a number array, a Uint8Array, or a JSON-serialized one. */
export const bytesFromWire = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'string') {
    return hexToBytes(value);
  }
  if (Array.isArray(value) && value.every(isByte)) {
    return Uint8Array.from(value);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > 0 && keys.every(k => /^\d+$/.test(k) && isByte(obj[k]))) {
      const out = new Uint8Array(keys.length);
      for (const k of keys) {
        out[Number(k)] = obj[k] as number;
      }
      return out;
    }
  }
  return undefined;
};

const reviveIn = (obj: Record<string, unknown>): void => {
  const hex = obj['cborHex'];
  const bytes =
    (typeof hex === 'string' ? bytesFromWire(hex) : undefined) ?? bytesFromWire(obj['cborData']);
  if (bytes) {
    obj['cborData'] = bytes;
  }
};

/** Copy a worker payload and revive `cborData` from `cborHex` (or a wire form). */
export const reviveCborPayload = <T>(payload: T): T => {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const next = { ...(payload as Record<string, unknown>) };
  reviveIn(next);
  const nested = next['zigner'];
  if (nested && typeof nested === 'object') {
    const zigner = { ...(nested as Record<string, unknown>) };
    reviveIn(zigner);
    next['zigner'] = zigner;
  }
  return next as T;
};

/** A source the QR may re-fountain: a real, non-empty Uint8Array only. */
export const isFountainBytes = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.byteLength > 0;

/** Re-encode only a non-empty Uint8Array; anything else is an encoding slip. */
export const fountainBytes = (value: unknown): Uint8Array => {
  if (!isFountainBytes(value)) {
    throw new Error(
      'cannot re-encode: need a non-empty Uint8Array (the message bus left a plain object, or the envelope was empty)',
    );
  }
  return value;
};

/**
 * Frames the QR should show: the re-encoded set when the source is
 * fountainable, otherwise the prebuilt ones (never an empty encoding).
 */
export const framesToShow = (
  urFrames: string[] | undefined,
  source: unknown,
  reencoded?: string[] | null,
): string[] => {
  if (isFountainBytes(source) && reencoded && reencoded.length > 0) {
    return reencoded;
  }
  return urFrames ?? [];
};
