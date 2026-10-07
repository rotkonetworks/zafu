/**
 * What the passkey bridge may forward to the service worker. The page writes
 * every byte of a request, so the bridge never spreads it: it copies only the
 * fields each kind uses, checks their types, and sets `type` itself. A page that
 * puts `type`, `origin`, `method` or anything else in its payload reaches no
 * other handler and speaks for no other site.
 */

export const PASSKEY_MESSAGE_TYPES = {
  create: 'zafu_passkey_create',
  get: 'zafu_passkey_get',
} as const;

export type PasskeyKind = keyof typeof PASSKEY_MESSAGE_TYPES;

const MAX_FIELD = 4096;
const MAX_ALLOW = 64;

const str = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_FIELD;
const hex = (v: unknown): v is string => str(v) && /^(?:[0-9a-f]{2})*$/i.test(v);

const prfSaltsOf = (v: unknown): { first: string; second?: string } | undefined | null => {
  if (v === undefined) {
    return undefined;
  }
  const s = v as { first?: unknown; second?: unknown } | null;
  if (typeof s !== 'object' || s === null || !hex(s.first)) {
    return null;
  }
  if (s.second !== undefined && !hex(s.second)) {
    return null;
  }
  return s.second === undefined ? { first: s.first } : { first: s.first, second: s.second };
};

const allowOf = (v: unknown): { id: string; type: string }[] | undefined | null => {
  if (v === undefined) {
    return undefined;
  }
  if (!Array.isArray(v) || v.length > MAX_ALLOW) {
    return null;
  }
  const out: { id: string; type: string }[] = [];
  for (const c of v as { id?: unknown; type?: unknown }[]) {
    if (typeof c !== 'object' || c === null || !hex(c.id) || !str(c.type)) {
      return null;
    }
    out.push({ id: c.id, type: c.type });
  }
  return out;
};

/** the service-worker message for a page request, or undefined when it is malformed */
export const passkeyMessage = (
  kind: string,
  payload: unknown,
): Record<string, unknown> | undefined => {
  if (!Object.hasOwn(PASSKEY_MESSAGE_TYPES, kind)) {
    return undefined;
  }
  const p = payload as Record<string, unknown> | null;
  if (typeof p !== 'object' || p === null || !str(p['rpId'])) {
    return undefined;
  }
  if (kind === 'create') {
    const { rpName, userName, userDisplayName, userId, prfRequested } = p;
    if (
      !hex(p['challenge']) ||
      !str(rpName ?? '') ||
      !str(userName ?? '') ||
      !str(userDisplayName ?? '') ||
      !hex(userId ?? '') ||
      (prfRequested !== undefined && typeof prfRequested !== 'boolean')
    ) {
      return undefined;
    }
    return {
      rpId: p['rpId'],
      challenge: p['challenge'],
      rpName,
      userName,
      userDisplayName,
      userId,
      prfRequested,
      // last, so nothing above can name another handler
      type: PASSKEY_MESSAGE_TYPES.create,
    };
  }
  const prfSalts = prfSaltsOf(p['prfSalts']);
  const allowCredentials = allowOf(p['allowCredentials']);
  if (
    !hex(p['challenge']) ||
    !hex(p['clientDataHash']) ||
    prfSalts === null ||
    allowCredentials === null
  ) {
    return undefined;
  }
  return {
    rpId: p['rpId'],
    // the worker rebuilds the client data from this and the sender's origin,
    // and signs only when it hashes to clientDataHash
    challenge: p['challenge'],
    clientDataHash: p['clientDataHash'],
    prfSalts,
    allowCredentials,
    type: PASSKEY_MESSAGE_TYPES.get,
  };
};

/**
 * After "not now" or a closed window a page waits before zafu shows it another
 * passkey screen: 30 s, then twice as long each time, back to 30 s after a
 * sign-in goes through. Kept in memory by the bridge, per page.
 */
export const promptCooldown = (base = 30_000) => {
  let until = 0;
  let wait = base;
  return {
    quiet: (now: number) => now < until,
    after: (res: unknown, now: number) => {
      const r = res as { success?: unknown; code?: unknown } | undefined;
      if (r?.code === 'denied' || r?.code === 'cancelled') {
        until = now + wait;
        wait *= 2;
      } else if (r?.success === true) {
        wait = base;
      }
    },
  };
};

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

/**
 * The CollectedClientData a browser would write, byte for byte. Shared by the
 * page-side intercept (which hands it to the site) and the service worker
 * (which rebuilds it from the browser-attested origin and refuses to sign a
 * hash of anything else), so the two can never drift apart.
 */
export const clientDataJson = (
  type: 'webauthn.create' | 'webauthn.get',
  challenge: Uint8Array,
  origin: string,
): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    JSON.stringify({ type, challenge: b64url(challenge), origin, crossOrigin: false }),
  );
