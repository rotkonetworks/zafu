/**
 * ring-vrf - anonymous "I belong" proof for pro subscribers.
 *
 * uses Bandersnatch Ring VRF to prove membership in the pro ring
 * without revealing which member you are. context-specific aliases
 * prevent cross-session linkability.
 *
 * the proof is attached to gRPC requests as metadata headers.
 * zidecar verifies the proof and grants priority sync.
 * free users still get full service - pro just gets priority under load.
 */

import type { AllSlices, SliceCreator } from '.';
import { ZidecarClient } from './keyring/zidecar-client';

export interface RingVrfSlice {
  /** current ring epoch (YYYY-MM-DD) */
  ringEpoch: string | null;
  /** cached ring keys (hex) */
  ringKeys: string[];
  /** user's index in the ring (-1 if not a member) */
  myIndex: number;
  /** ZID seed for proof generation */
  zidSeed: Uint8Array | null;
  /** whether ring VRF WASM is loaded */
  wasmReady: boolean;
  /** cached session proof (regenerated per sync session, not per request) */
  sessionProof: string | null;
  /** context for current session proof */
  sessionContext: string | null;

  /** refresh ring membership (fetch ring, find index) */
  refreshRing: (zidecarUrl: string, zidSeed: Uint8Array) => Promise<void>;
  /** generate a fresh session proof (call once per sync session) */
  newSessionProof: () => Promise<void>;
  /** get headers to attach to gRPC requests (reuses session proof) */
  getProofHeaders: () => Record<string, string>;
}

/** WASM module interface (lazy loaded) */
interface RingVrfWasm {
  derive_ring_pubkey: (seed: Uint8Array) => string;
  ring_vrf_prove: (seed: Uint8Array, ringKeysHex: string, myIndex: number, context: string) => string;
}

let wasmModule: RingVrfWasm | null = null;

async function loadWasm(): Promise<RingVrfWasm> {
  if (wasmModule) return wasmModule;
  try {
    // @ts-expect-error dynamic WASM import resolved at runtime
    const wasm = await import(/* webpackIgnore: true */ '/ring-vrf-wasm/ring_vrf_wasm.js');
    await wasm.default({ module_or_path: '/ring-vrf-wasm/ring_vrf_wasm_bg.wasm' });
    wasmModule = wasm as unknown as RingVrfWasm;
    return wasmModule;
  } catch (e) {
    console.warn('[ring-vrf] WASM load failed:', e);
    throw e;
  }
}

export const createRingVrfSlice = (): SliceCreator<RingVrfSlice> => (set, get) => ({
  ringEpoch: null,
  ringKeys: [],
  myIndex: -1,
  zidSeed: null,
  wasmReady: false,
  sessionProof: null,
  sessionContext: null,

  refreshRing: async (zidecarUrl: string, zidSeed: Uint8Array) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const cached = get().ringVrf;
      if (cached.ringEpoch === today && cached.myIndex >= 0) return;

      const wasm = await loadWasm();
      set(state => { state.ringVrf.wasmReady = true; });

      const myPubkey = wasm.derive_ring_pubkey(zidSeed);

      const client = new ZidecarClient(zidecarUrl);
      const ring = await client.getProRing();

      if (!ring.ringKeys.length) {
        console.log('[ring-vrf] empty ring');
        set(state => { state.ringVrf.myIndex = -1; });
        return;
      }

      const myIndex = ring.ringKeys.findIndex(k => k === myPubkey);
      if (myIndex < 0) {
        console.log('[ring-vrf] not in pro ring');
        set(state => { state.ringVrf.myIndex = -1; });
        return;
      }

      set(state => {
        state.ringVrf.ringEpoch = ring.epoch;
        state.ringVrf.ringKeys = ring.ringKeys;
        state.ringVrf.myIndex = myIndex;
        state.ringVrf.zidSeed = zidSeed;
        // invalidate old session proof on ring refresh
        state.ringVrf.sessionProof = null;
        state.ringVrf.sessionContext = null;
      });

      console.log('[ring-vrf] in pro ring at index', myIndex, 'epoch', ring.epoch);
    } catch (e) {
      console.warn('[ring-vrf] refresh failed:', e);
    }
  },

  newSessionProof: async () => {
    const { ringKeys, ringEpoch, myIndex, zidSeed } = get().ringVrf;
    if (!ringEpoch || myIndex < 0 || !zidSeed || !ringKeys.length) return;

    try {
      const wasm = await loadWasm();
      // one proof per sync session - unlinkable across sessions
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        b => b.toString(16).padStart(2, '0')).join('');
      const context = `zafu-pro-${ringEpoch}-${nonce}`;
      const ringKeysHex = ringKeys.join(',');
      const proof = wasm.ring_vrf_prove(zidSeed, ringKeysHex, myIndex, context);

      set(state => {
        state.ringVrf.sessionProof = proof;
        state.ringVrf.sessionContext = context;
      });

      console.log('[ring-vrf] new session proof generated');
    } catch (e) {
      console.warn('[ring-vrf] session proof failed:', e);
    }
  },

  getProofHeaders: (): Record<string, string> => {
    const { sessionProof, sessionContext } = get().ringVrf;
    if (!sessionProof || !sessionContext) return {};
    return {
      'x-zafu-ring-proof': sessionProof,
      'x-zafu-ring-context': sessionContext,
    };
  },
});

// selectors
export const ringVrfSelector = (state: AllSlices) => state.ringVrf;
export const isInProRing = (state: AllSlices) => state.ringVrf.myIndex >= 0;
