/**
 * zcash.me directory - read-only API, functional style.
 *
 * zcash.me is a username -> Zcash address directory with verified social
 * links (x, github, telegram, ...). Docs:
 *   https://zcash.me/docs/api
 *   https://github.com/zcashme/directory/blob/main/WALLET_API_README.md
 *
 * Endpoint surface, as probed 2026-09-07:
 *   GET /api/lookup/{username}    public, CORS *, cached 300s at the edge
 *   GET /api/directory?q&limit&cursor&verified_only   needs X-API-Key
 *   GET /api/resolve/{username}   needs X-API-Key
 *   GET /api/social?platform&handle   needs X-API-Key
 *
 * There is NO address -> profile endpoint. Reverse lookup (labelling a
 * tx counterparty) is only possible from a local copy of the whole
 * directory - see ./directory.ts.
 *
 * Privacy posture (why this module is shaped the way it is):
 *   - every per-name lookup tells zcash.me your ip AND which name you are
 *     paying. That is exactly the metadata a shielded wallet exists to
 *     hide, so "live" lookups are opt-in and fire only on an explicit
 *     user action - never in the background, never for autocomplete.
 *   - the preferred mode is "directory": fetch the whole directory once
 *     (one bulk download that looks the same for every user) and answer
 *     every name and address query locally. The server learns that you
 *     use the feature, not who you pay.
 *   - the bulk endpoint needs an API key. The key is ONE global server
 *     secret (see lib/api/guard.ts in zcashme/directory), so it must
 *     never be bundled into the extension. A user may paste their own
 *     key, or point at a snapshot mirror that holds the key server-side.
 *
 * No classes, no shared mutable state: every function takes its inputs
 * (including `fetch`) and returns data, so tests inject a fake fetch.
 */

export const ZCASHME_BASE_URL = 'https://zcash.me';

const FETCH_TIMEOUT_MS = 10_000;
/** the server clamps `limit` to 1..100 */
const DIRECTORY_PAGE_SIZE = 100;
/** hard stop on pagination so a misbehaving cursor can't loop forever */
const DIRECTORY_MAX_PAGES = 2_000;

/** a verified social link attached to a profile */
export interface ZcashMeLink {
  platform: string;
  label: string;
  url: string;
}

/**
 * the part of a zcash.me profile the wallet keeps. Same shape whether it
 * came from the public lookup endpoint or a directory page, so the picker
 * and the contact-save flow do not care which mode produced it.
 */
export interface ZcashMeProfile {
  /** canonical username. Unverified profiles come back as `name-<id>`. */
  username: string;
  displayName: string | null;
  address: string;
  /**
   * true only if the user proved control of `address` to zcash.me. An
   * unverified name can point anywhere - treat it as a hint, not a fact,
   * and say so in the UI before letting someone send to it.
   */
  addressVerified: boolean;
  bio: string | null;
  location: string | null;
  profileImageUrl: string | null;
  /** verified links only (the public endpoint never returns unverified) */
  links: ZcashMeLink[];
}

export type ZcashMeLookupError =
  | 'invalid_username'
  | 'not_found'
  | 'no_address'
  | 'unauthorized'
  | 'lookup_failed'
  | 'service_unavailable'
  | 'network';

export type ZcashMeLookupResult =
  | { ok: true; profile: ZcashMeProfile }
  | { ok: false; error: ZcashMeLookupError; message: string };

export const describeLookupError = (error: ZcashMeLookupError): string => {
  switch (error) {
    case 'invalid_username':
      return 'not a valid zcash.me username';
    case 'not_found':
      return 'no such zcash.me username';
    case 'no_address':
      return 'that zcash.me profile has no address set';
    case 'unauthorized':
      return 'zcash.me rejected the api key';
    case 'service_unavailable':
      return 'zcash.me is temporarily unavailable';
    case 'lookup_failed':
      return 'zcash.me lookup failed';
    case 'network':
      return 'could not reach zcash.me';
  }
};

// ---------------------------------------------------------------------------
// handle parsing
// ---------------------------------------------------------------------------

/**
 * username charset as enforced by the directory's slug rules. Kept strict
 * so a pasted address can never be mistaken for a handle.
 */
const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const HANDLE_FORMS: readonly RegExp[] = [
  // "/alice" - the slash shorthand the docs recommend wallets accept
  /^\/([A-Za-z0-9_-]+)\/?$/,
  // "zcash.me/alice", "https://zcash.me/alice", "www.zcash.me/alice/"
  /^(?:https?:\/\/)?(?:www\.)?zcash\.me\/([A-Za-z0-9_-]+)\/?$/i,
];

/**
 * Extract a zcash.me username from user input, or null when the input is
 * not a handle (an address, a search term, garbage). Only explicit forms
 * count - a bare word is a contact search, not a directory query, because
 * a directory query can leave the device.
 */
export const parseZcashMeHandle = (input: string): string | null => {
  const trimmed = input.trim();
  for (const re of HANDLE_FORMS) {
    const m = re.exec(trimmed);
    if (m?.[1] && USERNAME_RE.test(m[1])) {
      return m[1];
    }
  }
  return null;
};

/** case-insensitive key: zcash.me lookups are case-insensitive */
export const usernameKey = (username: string): string => username.toLowerCase();

/**
 * `name-123` is how the public endpoint labels an UNVERIFIED profile (the
 * numeric suffix is the row id, so two unverified "alice"s stay distinct).
 * Strip it when matching the typed name against the returned one.
 */
export const stripUnverifiedSuffix = (username: string): string => username.replace(/-\d+$/, '');

// ---------------------------------------------------------------------------
// wire shapes
// ---------------------------------------------------------------------------

interface LookupWire {
  username: string;
  display_name: string | null;
  address: string;
  address_verified: boolean;
  last_verified_at?: string | null;
  bio?: string | null;
  location?: string | null;
  profile_image_url?: string | null;
  links?: { platform?: string; label?: string; url?: string }[];
}

interface DirectoryLinkWire {
  id?: number;
  label?: string;
  url?: string;
  platform?: string;
  is_verified?: boolean;
}

interface DirectoryProfileWire {
  username: string;
  display_name: string | null;
  profile_image_url: string | null;
  bio: string | null;
  nearest_city_name: string | null;
  address: string | null;
  address_verified: boolean;
  verified_at: string | null;
  authenticated_links?: DirectoryLinkWire[];
  unauthenticated_links?: DirectoryLinkWire[];
}

interface DirectoryPageWire {
  results: DirectoryProfileWire[];
  next_cursor: string | null;
}

interface ErrorWire {
  error?: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** derive a platform name from a link url when the server omitted one */
const platformFromUrl = (url: string): string => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host === 'x.com' || host === 'twitter.com') {
      return 'x';
    }
    return host.split('.')[0] ?? host;
  } catch {
    return 'web';
  }
};

const normalizeLinks = (raw: readonly DirectoryLinkWire[] | undefined): ZcashMeLink[] => {
  const out: ZcashMeLink[] = [];
  for (const l of raw ?? []) {
    const url = str(l.url);
    if (!url) {
      continue;
    }
    out.push({
      platform: str(l.platform) ?? platformFromUrl(url),
      label: str(l.label) ?? url,
      url,
    });
  }
  return out;
};

export const profileFromLookup = (w: LookupWire): ZcashMeProfile => ({
  username: w.username,
  displayName: str(w.display_name),
  address: w.address,
  addressVerified: !!w.address_verified,
  bio: str(w.bio),
  location: str(w.location),
  profileImageUrl: str(w.profile_image_url),
  links: normalizeLinks(w.links),
});

/**
 * Directory rows may have no address at all (profile without a wallet);
 * those are useless to a wallet and are dropped, hence the nullable return.
 */
export const profileFromDirectory = (w: DirectoryProfileWire): ZcashMeProfile | null => {
  const address = str(w.address);
  if (!address || !str(w.username)) {
    return null;
  }
  return {
    username: w.username,
    displayName: str(w.display_name),
    address,
    addressVerified: !!w.address_verified,
    bio: str(w.bio),
    location: str(w.nearest_city_name),
    profileImageUrl: str(w.profile_image_url),
    // mirror the public endpoint: verified links only
    links: normalizeLinks(w.authenticated_links),
  };
};

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

export interface ZcashMeClientOptions {
  /** injected for tests; defaults to global fetch */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** only needed for the key-gated endpoints */
  apiKey?: string;
  signal?: AbortSignal;
}

const request = async (
  path: string,
  { fetch: doFetch = fetch, baseUrl = ZCASHME_BASE_URL, apiKey, signal }: ZcashMeClientOptions,
): Promise<Response> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return doFetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
};

const errorCodeOf = async (resp: Response): Promise<ZcashMeLookupError> => {
  let code: string | undefined;
  try {
    code = ((await resp.json()) as ErrorWire).error;
  } catch {
    code = undefined;
  }
  switch (code) {
    case 'invalid_username':
    case 'not_found':
    case 'no_address':
    case 'unauthorized':
    case 'service_unavailable':
      return code;
    default:
      if (resp.status === 401) {
        return 'unauthorized';
      }
      if (resp.status === 404) {
        return 'not_found';
      }
      if (resp.status === 503) {
        return 'service_unavailable';
      }
      return 'lookup_failed';
  }
};

/**
 * Resolve `realUsername` while also querying `decoyUsernames` in the same
 * burst, so zcash.me sees k real names at once with no marker of which is
 * the target. Every name must be a real 200 (see ./decoys.ts) or it stands
 * out. Decoy responses are discarded; decoy failures are swallowed so a
 * dead decoy never masks or reports as the real result. All requests are
 * launched together and awaited together - the real one is never singled
 * out by timing or early cancellation. Only the real result is returned.
 */
export interface DecoyLookupOptions extends ZcashMeClientOptions {
  /**
   * launch the k requests on a fixed cadence instead of all at once, so the
   * burst has a uniform rhythm rather than a single-instant fingerprint.
   * Each launch is spaced by `spacingMs` plus up to `spacingMs` of jitter.
   * 0 = one concurrent burst. Because queries fire only on the explicit
   * lookup action, this cadence is independent of how fast the user types.
   */
  spacingMs?: number;
  /** injected in tests so scheduling is deterministic */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

const jitter = (base: number): number =>
  base <= 0 ? 0 : base + (crypto.getRandomValues(new Uint32Array(1))[0]! / 0xffffffff) * base;

export const lookupZcashMeWithDecoys = async (
  realUsername: string,
  decoyUsernames: readonly string[],
  opts: DecoyLookupOptions = {},
): Promise<ZcashMeLookupResult> => {
  const { spacingMs = 0, sleep = defaultSleep, ...clientOpts } = opts;

  // de-dupe decoys, then randomise the real name's slot so neither launch
  // order nor position marks it
  const seen = new Set<string>();
  const order: { name: string; real: boolean }[] = [];
  for (const d of decoyUsernames) {
    if (!seen.has(d)) {
      seen.add(d);
      order.push({ name: d, real: false });
    }
  }
  const realIndex = crypto.getRandomValues(new Uint32Array(1))[0]! % (order.length + 1);
  order.splice(realIndex, 0, { name: realUsername, real: true });

  let realResult: ZcashMeLookupResult | null = null;
  const inflight: Promise<void>[] = [];
  for (let i = 0; i < order.length; i++) {
    const entry = order[i]!;
    inflight.push(
      lookupZcashMe(entry.name, clientOpts).then(res => {
        if (entry.real) {
          realResult = res;
        }
        // decoy results are intentionally dropped
      }),
    );
    if (spacingMs > 0 && i < order.length - 1) {
      await sleep(jitter(spacingMs));
    }
  }
  await Promise.all(inflight);
  return (
    realResult ?? {
      ok: false,
      error: 'lookup_failed',
      message: describeLookupError('lookup_failed'),
    }
  );
};

/**
 * Resolve one username via the PUBLIC lookup endpoint. This request tells
 * zcash.me your ip and the name - call it only from an explicit user
 * action with the "live lookup" mode enabled.
 */
export const lookupZcashMe = async (
  username: string,
  opts: ZcashMeClientOptions = {},
): Promise<ZcashMeLookupResult> => {
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error: 'invalid_username',
      message: describeLookupError('invalid_username'),
    };
  }
  let resp: Response;
  try {
    resp = await request(`/api/lookup/${encodeURIComponent(username)}`, opts);
  } catch (e) {
    return {
      ok: false,
      error: 'network',
      message: e instanceof Error ? e.message : describeLookupError('network'),
    };
  }
  if (!resp.ok) {
    const error = await errorCodeOf(resp);
    return { ok: false, error, message: describeLookupError(error) };
  }
  try {
    const wire = (await resp.json()) as LookupWire;
    if (!str(wire.username) || !str(wire.address)) {
      return { ok: false, error: 'lookup_failed', message: 'malformed zcash.me response' };
    }
    return { ok: true, profile: profileFromLookup(wire) };
  } catch {
    return { ok: false, error: 'lookup_failed', message: 'malformed zcash.me response' };
  }
};

export interface DirectoryFetchProgress {
  pages: number;
  profiles: number;
}

/**
 * Page through the WHOLE directory (key-gated). One bulk pull that is
 * identical for every caller - the privacy-preserving way to get
 * name->address and address->name without per-query leaks.
 *
 * Throws on any http/network failure: a partial directory would silently
 * mislabel counterparties, so the caller keeps its previous snapshot.
 */
export const fetchDirectoryAll = async (
  opts: ZcashMeClientOptions & { onProgress?: (p: DirectoryFetchProgress) => void },
): Promise<ZcashMeProfile[]> => {
  if (!opts.apiKey) {
    throw new Error('zcash.me directory download needs an api key');
  }
  const profiles: ZcashMeProfile[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < DIRECTORY_MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: String(DIRECTORY_PAGE_SIZE) });
    if (cursor) {
      qs.set('cursor', cursor);
    }
    const resp = await request(`/api/directory?${qs.toString()}`, opts);
    if (!resp.ok) {
      const error = await errorCodeOf(resp);
      throw new Error(`${describeLookupError(error)} (HTTP ${resp.status})`);
    }
    const body = (await resp.json()) as DirectoryPageWire;
    if (!Array.isArray(body.results)) {
      throw new Error('malformed zcash.me directory page');
    }
    for (const row of body.results) {
      const p = profileFromDirectory(row);
      if (p) {
        profiles.push(p);
      }
    }
    opts.onProgress?.({ pages: page + 1, profiles: profiles.length });
    if (!body.next_cursor || body.results.length === 0) {
      return profiles;
    }
    cursor = body.next_cursor;
  }
  throw new Error('zcash.me directory pagination did not terminate');
};
