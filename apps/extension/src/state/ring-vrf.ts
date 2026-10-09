/**
 * ring-vrf - anonymous "I belong" proof for pro subscribers.
 *
 * uses Bandersnatch Ring VRF to prove membership in the pro ring
 * without revealing which member you are. context-specific aliases
 * prevent cross-session linkability.
 *
 * never attached to zidecar calls: a proof riding on sync and on nym
 * lookups alike linked a pro member's nym traffic to their ip.
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

  /** refresh ring membership (fetch ring, find index) */
  refreshRing: (zidecarUrl: string, zidSeed: Uint8Array) => Promise<void>;
}

/** WASM module interface (lazy loaded) */
interface RingVrfWasm {
  derive_ring_pubkey: (seed: Uint8Array) => string;
}

let wasmModule: RingVrfWasm | null = null;
let wasmFailed = false;

async function loadWasm(): Promise<RingVrfWasm> {
  if (wasmModule) {
    return wasmModule;
  }
  // don't retry a known-failed load - warn once, then fail silently
  if (wasmFailed) {
    throw new Error('ring-vrf WASM unavailable');
  }
  try {
    // literal specifiers into /public break vitest's vite transform, so the
    // path lives in a variable - both bundlers then defer to runtime
    const wasmPath = '/ring-vrf-wasm/ring_vrf_wasm.js';
    const wasm = await import(/* webpackIgnore: true */ /* @vite-ignore */ wasmPath);
    await wasm.default({ module_or_path: '/ring-vrf-wasm/ring_vrf_wasm_bg.wasm' });
    wasmModule = wasm as unknown as RingVrfWasm;
    return wasmModule;
  } catch (e) {
    wasmFailed = true;
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

  refreshRing: async (zidecarUrl: string, zidSeed: Uint8Array) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const cached = get().ringVrf;
      if (cached.ringEpoch === today && cached.myIndex >= 0) {
        return;
      }

      const wasm = await loadWasm();
      set(state => {
        state.ringVrf.wasmReady = true;
      });

      const myPubkey = wasm.derive_ring_pubkey(zidSeed);

      const client = new ZidecarClient(zidecarUrl);
      const ring = await client.getProRing();

      if (!ring.ringKeys.length) {
        console.log('[ring-vrf] empty ring');
        set(state => {
          state.ringVrf.myIndex = -1;
        });
        return;
      }

      const myIndex = ring.ringKeys.findIndex(k => k === myPubkey);
      if (myIndex < 0) {
        console.log('[ring-vrf] not in pro ring');
        set(state => {
          state.ringVrf.myIndex = -1;
        });
        return;
      }

      set(state => {
        state.ringVrf.ringEpoch = ring.epoch;
        state.ringVrf.ringKeys = ring.ringKeys;
        state.ringVrf.myIndex = myIndex;
        state.ringVrf.zidSeed = zidSeed;
      });

      // the ring index alone singles a member out of the ring: never logged
      console.log('[ring-vrf] in pro ring');
    } catch (e) {
      if (!wasmFailed) {
        console.warn('[ring-vrf] refresh failed:', e);
      }
    }
  },
});

// selectors
export const ringVrfSelector = (state: AllSlices) => state.ringVrf;
export const isInProRing = (state: AllSlices) => state.ringVrf.myIndex >= 0;
