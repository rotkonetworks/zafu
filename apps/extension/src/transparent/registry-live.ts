/**
 * A newer penumbrafi registry than the one bundled, fetched from registry.penumbra.fi only
 * after the user says yes, and only when their Penumbra node reports a live
 * channel to a chain zafu doesn't know. It is used only when it carries a valid
 * signature by the key below over its exact bytes and a version newer than the
 * bundled copy and any copy already stored. Anything else is ignored and the
 * bundled registry stays. Even a verified copy only adds chains zafu does not
 * know: it never re-pins a known chain's channels (see applyLiveConnections).
 *
 * Signed in penumbrafi/registry with `just sign` (tools/sign/sign.mjs), whose
 * message format this mirrors.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { Chain, Registry } from '@penumbrafi/registry';
import bundledPackage from '@penumbrafi/registry/package.json';
import { applyLiveConnections } from '@repo/wallet/networks/cosmos/chains';
import { LIVE_REGISTRY_SIG_URL, LIVE_REGISTRY_URL } from './registry-endpoint';

type JsonRegistry = ConstructorParameters<typeof Registry>[0];

const CHAIN_ID = 'penumbra-1';
const FORMAT = 'penumbrafi-registry-sig/1';
/** the registry signing key, raw ed25519, base64 */
export const REGISTRY_PUBLIC_KEY = 'EHH46McQdpD1M6LVrvk7MbzvCIF6QNXFiqWi3Z0GPcM=';
const KEY = 'penumbraRegistryLive';

export interface RegistrySig {
  format: string;
  chainId: string;
  version: string;
  sha256: string;
  signature: string;
}

/** what is kept in storage: the signed bytes as text, and their signature */
export interface StoredRegistry {
  text: string;
  sig: RegistrySig;
}

const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

/** -1, 0, 1 for dotted numeric versions; anything unparsable sorts lowest */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : [-1]);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) {
      return Math.sign(d);
    }
  }
  return 0;
};

/**
 * The registry's connections when `text` is signed by `publicKey` and newer
 * than `floor`; undefined otherwise (never throws).
 */
export const verifyRegistry = (
  text: string,
  sig: RegistrySig,
  floor: string,
  publicKey = REGISTRY_PUBLIC_KEY,
): Chain[] | undefined => {
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = bytesToHex(sha256(bytes));
    if (sig.format !== FORMAT || sig.chainId !== CHAIN_ID || sig.sha256 !== digest) {
      return undefined;
    }
    const message = new TextEncoder().encode(
      `${FORMAT}\n${sig.chainId}\n${sig.version}\n${sig.sha256}\n`,
    );
    if (!ed25519.verify(fromBase64(sig.signature), message, fromBase64(publicKey))) {
      return undefined;
    }
    if (compareVersions(sig.version, floor) <= 0) {
      return undefined;
    }
    const json = JSON.parse(text) as { chainId?: string; ibcConnections?: Chain[] };
    return json.chainId === CHAIN_ID && Array.isArray(json.ibcConnections)
      ? json.ibcConnections
      : undefined;
  } catch {
    return undefined;
  }
};

export const BUNDLED_REGISTRY_VERSION = bundledPackage.version;

/** the stored copy's registry JSON when it still verifies and is newer than the bundled one */
export const storedRegistryJson = async (): Promise<JsonRegistry | undefined> => {
  const stored = await readStored();
  if (!stored || !verifyRegistry(stored.text, stored.sig, BUNDLED_REGISTRY_VERSION)) {
    return undefined;
  }
  return JSON.parse(stored.text) as JsonRegistry;
};

const readStored = async (): Promise<StoredRegistry | undefined> => {
  try {
    return (await chrome.storage.local.get(KEY))[KEY] as StoredRegistry | undefined;
  } catch {
    return undefined;
  }
};

/**
 * Boot: re-verify the stored copy and layer it over the bundled registry.
 * Reads storage only, never the network. Returns the chains it added.
 */
export const loadStoredRegistry = async (): Promise<string[]> => {
  const stored = await readStored();
  const connections = stored && verifyRegistry(stored.text, stored.sig, BUNDLED_REGISTRY_VERSION);
  return connections ? applyLiveConnections(connections) : [];
};

/**
 * Fetch the live registry (the caller has the user's opt-in) and keep it when
 * it verifies and is newer than what zafu already has. Returns the chains it
 * added; nothing on any failure.
 */
export const fetchLiveRegistry = async (): Promise<string[]> => {
  try {
    const stored = await readStored();
    const floor =
      stored && compareVersions(stored.sig.version, BUNDLED_REGISTRY_VERSION) > 0
        ? stored.sig.version
        : BUNDLED_REGISTRY_VERSION;
    const [text, sig] = await Promise.all([
      fetch(LIVE_REGISTRY_URL, { cache: 'no-cache' }).then(r => (r.ok ? r.text() : '')),
      fetch(LIVE_REGISTRY_SIG_URL, { cache: 'no-cache' }).then(r =>
        r.ok ? (r.json() as Promise<RegistrySig>) : undefined,
      ),
    ]);
    const connections = sig && verifyRegistry(text, sig, floor);
    if (!connections || !sig) {
      return [];
    }
    await chrome.storage.local.set({ [KEY]: { text, sig } satisfies StoredRegistry });
    return applyLiveConnections(connections);
  } catch {
    return [];
  }
};

/** the live chain ids none of zafu's chains have: what a newer registry may cover */
export const unknownLiveChains = (
  routes: readonly { chainId: string; active: boolean }[],
  known: (chainId: string) => boolean,
): string[] => [...new Set(routes.filter(r => r.active && !known(r.chainId)).map(r => r.chainId))];

const ASKED_KEY = 'penumbraRegistryAsked';
const FETCH_EVERY_MS = 24 * 60 * 60 * 1000;

interface AskState {
  /** live chain ids already asked about, so a "no" isn't asked again */
  chains: string[];
  /** last fetch, epoch ms */
  fetchedAt: number;
}

const readAsk = async (): Promise<AskState> => {
  try {
    const v = (await chrome.storage.local.get(ASKED_KEY))[ASKED_KEY] as AskState | undefined;
    return { chains: v?.chains ?? [], fetchedAt: v?.fetchedAt ?? 0 };
  } catch {
    return { chains: [], fetchedAt: 0 };
  }
};

/**
 * When the user's Penumbra node reports a live channel to a chain zafu doesn't
 * know, ask (once per such chain) to fetch the signed registry, and fetch it on
 * a yes, at most daily. Returns the chains added.
 */
export const refreshForUnknownChains = async (
  routes: readonly { chainId: string; active: boolean }[],
  deps: {
    known: (chainId: string) => boolean;
    optIn: () => Promise<boolean>;
    fetch: () => Promise<string[]>;
    now?: () => number;
    state?: { read: () => Promise<AskState>; write: (s: AskState) => Promise<void> };
  },
): Promise<string[]> => {
  const unknown = unknownLiveChains(routes, deps.known);
  if (!unknown.length) {
    return [];
  }
  const state = deps.state ?? {
    read: readAsk,
    write: (s: AskState) => chrome.storage.local.set({ [ASKED_KEY]: s }),
  };
  const now = (deps.now ?? Date.now)();
  const prev = await state.read();
  const fresh = unknown.some(c => !prev.chains.includes(c));
  // nothing new to ask about: refetch only for someone who said yes, daily
  if (!fresh && (!prev.fetchedAt || now - prev.fetchedAt < FETCH_EVERY_MS)) {
    return [];
  }
  const chains = [...new Set([...prev.chains, ...unknown])];
  if (!(await deps.optIn())) {
    await state.write({ chains, fetchedAt: prev.fetchedAt });
    return [];
  }
  await state.write({ chains, fetchedAt: now });
  return deps.fetch();
};
