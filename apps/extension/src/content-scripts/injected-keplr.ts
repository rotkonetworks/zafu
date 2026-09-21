/**
 * MAIN-world Keplr-compatible provider. Injected into every page so cosmos
 * dapps (Skip Go, cosmos-kit, graz, ...) detect `window.keplr` and connect to
 * this extension exactly as they would to Keplr.
 *
 * This script has no chrome.runtime access. It speaks to the ISOLATED bridge
 * (keplr-bridge.ts) over window.postMessage; the bridge relays to the service
 * worker. Because the chrome.runtime hop is JSON-only, all binary (pubkeys,
 * signatures, signDoc bytes) crosses the wire base64-encoded and is rebuilt
 * into Uint8Array here before it reaches the dapp.
 *
 * Trust note: like any injected provider, everything here is only as trustable
 * as the page's other scripts. Signing still requires explicit user approval in
 * the extension - the provider cannot authorize anything on its own.
 */

export {}; // module scope - keeps CHANNEL etc. out of the shared MAIN-world global

const CHANNEL = 'zafu-keplr';
const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const bytesToB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const byte of bytes) {
    s += String.fromCharCode(byte);
  }
  return btoa(s);
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}
const pending = new Map<string, PendingRequest>();

let seq = 0;
const nextId = (): string => `${Date.now()}-${seq++}`;

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) {
    return;
  }
  const data = ev.data as
    | {
        channel?: string;
        direction?: string;
        id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
      }
    | undefined;
  if (data?.channel !== CHANNEL || data.direction !== 'response' || !data.id) {
    return;
  }
  const req = pending.get(data.id);
  if (!req) {
    return;
  }
  pending.delete(data.id);
  if (data.ok) {
    req.resolve(data.result);
  } else {
    req.reject(new Error(data.error ?? 'zafu keplr request failed'));
  }
});

/**
 * Send a method call to the bridge and await its result. `native` marks a call
 * that came through zafu's OWN provider (window.zafu) rather than the Keplr
 * impersonation (window.keplr): native calls are always allowed, whereas the
 * window.keplr path stays behind the opt-in Keplr-compat gate (see keplr-bridge).
 */
const request = <T = unknown>(method: string, params: unknown, native = false): Promise<T> => {
  const id = nextId();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.postMessage(
      { channel: CHANNEL, direction: 'request', id, method, params, native },
      window.origin,
    );
  });
};

interface KeplrKey {
  name: string;
  algo: string;
  pubKey: Uint8Array;
  address: Uint8Array;
  bech32Address: string;
  isNanoLedger: boolean;
  isKeystone: boolean;
}

interface WireKey {
  name: string;
  algo: string;
  pubKeyB64: string;
  addressB64: string;
  bech32Address: string;
}

const decodeKey = (w: WireKey): KeplrKey => ({
  name: w.name,
  algo: w.algo,
  pubKey: b64ToBytes(w.pubKeyB64),
  address: b64ToBytes(w.addressB64),
  bech32Address: w.bech32Address,
  isNanoLedger: false,
  isKeystone: false,
});

interface AccountData {
  address: string;
  algo: string;
  pubkey: Uint8Array;
}

/** offline signer covering both amino and direct signing */
const makeOfflineSigner = (chainId: string, native = false) => ({
  getAccounts: async (): Promise<AccountData[]> => {
    const key = decodeKey(await request<WireKey>('getKey', { chainId }, native));
    return [{ address: key.bech32Address, algo: key.algo, pubkey: key.pubKey }];
  },
  signAmino: async (signerAddress: string, signDoc: unknown) => {
    const res = await request<{
      signedB64?: string;
      signed: unknown;
      signatureB64: string;
      pubKeyB64: string;
    }>('signAmino', { chainId, signerAddress, signDoc }, native);
    return {
      signed: res.signed,
      signature: {
        pub_key: { type: 'tendermint/PubKeySecp256k1', value: res.pubKeyB64 },
        signature: res.signatureB64,
      },
    };
  },
  signDirect: async (
    signerAddress: string,
    signDoc: {
      bodyBytes: Uint8Array;
      authInfoBytes: Uint8Array;
      chainId: string;
      accountNumber: bigint;
    },
  ) => {
    const res = await request<{
      bodyB64: string;
      authInfoB64: string;
      accountNumber: string;
      chainId: string;
      signatureB64: string;
      pubKeyB64: string;
    }>(
      'signDirect',
      {
        chainId,
        signerAddress,
        signDoc: {
          bodyBytesB64: bytesToB64(signDoc.bodyBytes),
          authInfoBytesB64: bytesToB64(signDoc.authInfoBytes),
          chainId: signDoc.chainId,
          accountNumber: signDoc.accountNumber.toString(),
        },
      },
      native,
    );
    return {
      signed: {
        bodyBytes: b64ToBytes(res.bodyB64),
        authInfoBytes: b64ToBytes(res.authInfoB64),
        chainId: res.chainId,
        accountNumber: BigInt(res.accountNumber),
      },
      signature: {
        pub_key: { type: 'tendermint/PubKeySecp256k1', value: res.pubKeyB64 },
        signature: res.signatureB64,
      },
    };
  },
});

// The provider surface, parameterized by `native`. `native=false` backs the
// Keplr-impersonation at window.keplr (opt-in, defers to a real Keplr);
// `native=true` backs zafu's own window.zafu (always on, its own slot). Both
// speak the identical Keplr interface so cosmos-kit / graz / Skip drive either.
const makeProvider = (native: boolean) => ({
  version: 'zafu-0.1',
  mode: 'extension' as const,

  enable: async (chainIds: string | string[]): Promise<void> => {
    await request('enable', { chainIds: Array.isArray(chainIds) ? chainIds : [chainIds] }, native);
  },

  disable: async (chainIds?: string | string[]): Promise<void> => {
    await request(
      'disable',
      { chainIds: chainIds ? (Array.isArray(chainIds) ? chainIds : [chainIds]) : [] },
      native,
    );
  },

  getKey: async (chainId: string): Promise<KeplrKey> =>
    decodeKey(await request<WireKey>('getKey', { chainId }, native)),

  experimentalSuggestChain: async (chainInfo: unknown): Promise<void> => {
    await request('experimentalSuggestChain', { chainInfo }, native);
  },

  getOfflineSigner: (chainId: string) => makeOfflineSigner(chainId, native),
  getOfflineSignerOnlyAmino: (chainId: string) => {
    const s = makeOfflineSigner(chainId, native);
    return { getAccounts: s.getAccounts, signAmino: s.signAmino };
  },
  getOfflineSignerAuto: async (chainId: string) => makeOfflineSigner(chainId, native),

  signAmino: async (chainId: string, signer: string, signDoc: unknown) =>
    makeOfflineSigner(chainId, native).signAmino(signer, signDoc),
  signDirect: async (
    chainId: string,
    signer: string,
    signDoc: {
      bodyBytes: Uint8Array;
      authInfoBytes: Uint8Array;
      chainId: string;
      accountNumber: bigint;
    },
  ) => makeOfflineSigner(chainId, native).signDirect(signer, signDoc),

  sendTx: async (chainId: string, tx: Uint8Array, mode: string): Promise<Uint8Array> => {
    const res = await request<{ hashB64: string }>(
      'sendTx',
      { chainId, txB64: bytesToB64(tx), mode },
      native,
    );
    return b64ToBytes(res.hashB64);
  },
});

// window.keplr impersonation provider (gated) and zafu's own provider (native).
const keplr = makeProvider(false);
const zafuProvider = makeProvider(true);

// Keplr compatibility is OPT-IN (default off). Injecting window.keplr
// unconditionally clobbered a user's real Keplr: with `writable: false`,
// whichever extension won the document_start race locked the slot and shut the
// other out. So we do not touch window.keplr until the ISOLATED bridge, which
// alone can read the setting, tells us the user turned compatibility on - and
// even then only if nothing already claims the slot, so a real Keplr always
// wins. `configurable: true` keeps us from permanently locking it either way.
let installed = false;
const installKeplr = (): void => {
  if (installed || 'keplr' in window) {
    return; // already ours, or a real Keplr is present - never clobber it
  }
  installed = true;
  Object.defineProperty(window, 'keplr', { value: keplr, writable: false, configurable: true });
  Object.defineProperty(window, 'getOfflineSigner', {
    value: (chainId: string) => keplr.getOfflineSigner(chainId),
    writable: false,
    configurable: true,
  });
  Object.defineProperty(window, 'getOfflineSignerOnlyAmino', {
    value: (chainId: string) => keplr.getOfflineSignerOnlyAmino(chainId),
    writable: false,
    configurable: true,
  });
  Object.defineProperty(window, 'getOfflineSignerAuto', {
    value: (chainId: string) => keplr.getOfflineSignerAuto(chainId),
    writable: false,
    configurable: true,
  });
  // let dapps that already probed re-detect the newly present provider
  window.dispatchEvent(new Event('keplr_keystorechange'));
};

// zafu's OWN cosmos provider. Unlike the window.keplr impersonation above, this
// lives on its own slot (window.zafu), so it never races or clobbers a real
// Keplr and needs no opt-in - a dapp (or our cosmos-kit adapter) that explicitly
// picks "Zafu" always finds it. This is the reliable path; the window.keplr
// impersonation stays only for third-party dapps that hard-code window.keplr.
// Signing still requires explicit in-extension approval, so an always-present
// provider grants no authority on its own.
let zafuInstalled = false;
const installZafu = (): void => {
  if (zafuInstalled || 'zafu' in window) {
    return;
  }
  zafuInstalled = true;
  Object.defineProperty(window, 'zafu', { value: zafuProvider, writable: false, configurable: true });
  window.dispatchEvent(new Event('zafu_keystorechange'));
};
// Install immediately - no gate, no slot race.
installZafu();

// the ISOLATED bridge reads the opt-in flag (it has chrome.storage access) and
// posts this once, only when the user has enabled Keplr compatibility
window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) {
    return;
  }
  const d = ev.data as { channel?: string; direction?: string } | undefined;
  if (d?.channel === CHANNEL && d.direction === 'enable') {
    // NOTE: a page could forge this 'enable' (MAIN world can't authenticate the
    // ISOLATED-world bridge across postMessage). That only installs an INERT
    // window.keplr: enforcement of the opt-in lives on the request path in
    // keplr-bridge.ts, which drops every method call unless keplrCompat is on. So
    // a forged enable yields a provider object that answers "disabled" to
    // everything - a minor fingerprint, not a functional bypass. install is
    // idempotent and never clobbers a real Keplr.
    installKeplr();
  }
});
