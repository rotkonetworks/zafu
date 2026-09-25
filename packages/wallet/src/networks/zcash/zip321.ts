/**
 * ZIP 321 payment request URIs: `zcash:<address>?amount=&memo=&label=&message=`
 * and the indexed multi-payment form (`address.1`, `amount.1`, ...).
 * https://zips.z.cash/zip-0321
 *
 * Pure parsing and building - no address validation beyond "is it
 * transparent" (the send form validates the address itself). Anything the spec
 * calls invalid is rejected whole, never half-applied.
 */

export interface Zip321Payment {
  address: string;
  /** zatoshis; undefined = the payer chooses */
  amountZat?: bigint;
  /** the memo as text; undefined when absent */
  memo?: string;
  label?: string;
  message?: string;
}

export type Zip321Result = { ok: true; payments: Zip321Payment[] } | { ok: false; error: string };

const MAX_ZAT = 21_000_000n * 100_000_000n;
const MAX_MEMO_BYTES = 512;
const AMOUNT = /^(\d+)(\.\d{1,8})?$/;
/** addresses are bare alphanumerics: no percent-encoding, no `//` */
const ADDRESS = /^[A-Za-z0-9]+$/;
/** `name` or `name.N`, N in 1..9999 without leading zeros */
const PARAM = /^([a-zA-Z][a-zA-Z0-9+-]*)(?:\.([1-9]\d{0,3}))?$/;

/** t-addresses (and TEX) can't carry a memo */
export const isTransparentAddress = (address: string): boolean =>
  /^(t1|t3|tm|t2|tex1|textest1)/.test(address);

export const isZip321Uri = (text: string): boolean => /^zcash:/i.test(text.trim());

/** decimal ZEC -> zatoshis, exact */
export function parseZecAmount(text: string): bigint | undefined {
  const m = AMOUNT.exec(text);
  const whole = m?.[1];
  if (!whole) {
    return undefined;
  }
  const frac = (m[2] ?? '.').slice(1).padEnd(8, '0');
  const zat = BigInt(whole) * 100_000_000n + BigInt(frac || '0');
  return zat <= MAX_ZAT ? zat : undefined;
}

/** zatoshis -> the shortest decimal ZEC string */
export function formatZecAmount(zat: bigint): string {
  const whole = zat / 100_000_000n;
  const frac = (zat % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function decodeBase64Url(text: string): Uint8Array | undefined {
  // unpadded base64url only
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c =>
      c.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function percentDecode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

export function parseZip321(uri: string): Zip321Result {
  const text = uri.trim();
  if (!isZip321Uri(text)) {
    return { ok: false, error: 'not a zcash: payment request' };
  }
  const rest = text.slice('zcash:'.length);
  const q = rest.indexOf('?');
  const pathAddress = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);
  if (pathAddress && !ADDRESS.test(pathAddress)) {
    return { ok: false, error: 'malformed address' };
  }

  const byIndex = new Map<number, Map<string, string>>();
  const put = (index: number, name: string, value: string): string | undefined => {
    const entry = byIndex.get(index) ?? new Map<string, string>();
    if (entry.has(name)) {
      return `duplicate ${name}`;
    }
    entry.set(name, value);
    byIndex.set(index, entry);
    return undefined;
  };
  if (pathAddress) {
    put(0, 'address', pathAddress);
  }

  for (const pair of query ? query.split('&') : []) {
    if (pair === '') {
      continue; // the grammar allows empty parameters
    }
    const eq = pair.indexOf('=');
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    const m = PARAM.exec(rawName);
    const name = m?.[1];
    if (!name) {
      return { ok: false, error: `malformed parameter "${rawName}"` };
    }
    const idx = m[2];
    const lower = name.toLowerCase();
    const known = ['address', 'amount', 'memo', 'label', 'message'].includes(lower);
    if (!known) {
      if (lower.startsWith('req-')) {
        return { ok: false, error: `unsupported required parameter "${name}"` };
      }
      continue; // unknown optional parameters are ignored
    }
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    // percent-encoding is only allowed in label and message values
    const value = lower === 'label' || lower === 'message' ? percentDecode(raw) : raw;
    if (value === undefined || (lower === 'address' && !ADDRESS.test(value))) {
      return { ok: false, error: `malformed ${lower}` };
    }
    const dup = put(idx ? Number(idx) : 0, lower, value);
    if (dup) {
      return { ok: false, error: dup };
    }
  }

  if (byIndex.size === 0) {
    return { ok: false, error: 'no payment in the request' };
  }
  const payments: Zip321Payment[] = [];
  for (const [index, p] of [...byIndex].sort(([a], [b]) => a - b)) {
    const address = p.get('address');
    if (!address) {
      return { ok: false, error: `payment ${index} has no address` };
    }
    const out: Zip321Payment = { address };
    const amount = p.get('amount');
    if (amount !== undefined) {
      const zat = parseZecAmount(amount);
      if (zat === undefined) {
        return { ok: false, error: `invalid amount "${amount}"` };
      }
      out.amountZat = zat;
    }
    const memo = p.get('memo');
    if (memo !== undefined) {
      if (isTransparentAddress(address)) {
        return { ok: false, error: 'a memo cannot be sent to a transparent address' };
      }
      const bytes = decodeBase64Url(memo);
      if (!bytes || bytes.length > MAX_MEMO_BYTES) {
        return { ok: false, error: 'invalid memo' };
      }
      try {
        out.memo = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return { ok: false, error: 'binary memos are not supported' };
      }
    }
    const label = p.get('label');
    const message = p.get('message');
    if (label !== undefined) {
      out.label = label;
    }
    if (message !== undefined) {
      out.message = message;
    }
    payments.push(out);
  }
  return { ok: true, payments };
}

/** a single-payment request URI, e.g. for a receive QR */
export function buildZip321(p: Zip321Payment): string {
  const params: string[] = [];
  if (p.amountZat !== undefined) {
    params.push(`amount=${formatZecAmount(p.amountZat)}`);
  }
  if (p.memo) {
    if (isTransparentAddress(p.address)) {
      throw new Error('a memo cannot be sent to a transparent address');
    }
    params.push(`memo=${encodeBase64Url(new TextEncoder().encode(p.memo))}`);
  }
  if (p.label) {
    params.push(`label=${encodeURIComponent(p.label)}`);
  }
  if (p.message) {
    params.push(`message=${encodeURIComponent(p.message)}`);
  }
  return `zcash:${p.address}${params.length ? `?${params.join('&')}` : ''}`;
}
