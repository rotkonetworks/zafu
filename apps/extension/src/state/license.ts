/**
 * license state - tracks pro subscription status.
 *
 * license is fetched DIRECTLY from rotko's license-server over HTTPS.
 * never through zidecar - keeps license identity separate from sync identity.
 *
 * sync priority uses ring VRF proofs (anonymous, unlinkable).
 *   free  = normal sync (always works)
 *   pro   = priority queue under load
 */

import type { AllSlices, SliceCreator } from '.';
import { isLicenseValid, hasProFeature, daysRemaining, parseLicense, type License, type Plan, type ProFeature } from '@repo/wallet/license';
import { localExtStorage } from '@repo/storage-chrome/local';
import { bytesToHex } from '@noble/hashes/utils';

/** direct license-server endpoint - never goes through zidecar */
const LICENSE_SERVER = 'https://zpro.rotko.net';

export interface PendingPayment {
  /** amount in zatoshi seen but not yet credited */
  pendingZat: number;
  /** current confirmations */
  pendingConfs: number;
  /** confirmations required to credit */
  requiredConfs: number;
}

export interface LicenseSlice {
  license: License | null;
  loading: boolean;
  pending: PendingPayment | null;

  /** load license from storage on startup */
  loadLicense: () => Promise<void>;
  /** store a new license */
  setLicense: (license: License) => Promise<void>;
  /** fetch license directly from license-server by ZID pubkey */
  fetchLicense: (zid: string, ringPubkey?: Uint8Array) => Promise<License | null>;
  /** update pending payment info from server */
  setPending: (pending: PendingPayment | null) => void;
  /** clear license */
  clearLicense: () => Promise<void>;
}

export const createLicenseSlice = (): SliceCreator<LicenseSlice> => (set, get) => ({
  license: null,
  loading: false,
  pending: null,

  loadLicense: async () => {
    set(state => { state.license.loading = true; });
    const raw = await localExtStorage.get('proLicense') as string | undefined;
    const license = raw ? parseLicense(raw) : null;

    set(state => {
      state.license.license = license;
      state.license.loading = false;
    });
  },

  setLicense: async (license: License) => {
    await localExtStorage.set('proLicense', JSON.stringify(license));

    set(state => { state.license.license = license; });
  },

  fetchLicense: async (zid: string, ringPubkey?: Uint8Array) => {
    set(state => { state.license.loading = true; });
    try {
      // build URL with optional ring pubkey query param
      const url = new URL(`/license/${zid}`, LICENSE_SERVER);
      if (ringPubkey) {
        url.searchParams.set('ring_pubkey', bytesToHex(ringPubkey));
      }

      const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!resp.ok) {
        set(state => { state.license.loading = false; });
        return null;
      }

      const info = await resp.json() as {
        zid: string;
        plan: string;
        expires: number;
        signature: string;
      };

      if (!info.signature || info.plan === 'free') {
        set(state => { state.license.loading = false; });
        return null;
      }

      const license: License = {
        zid: info.zid,
        plan: info.plan as Plan,
        expires: info.expires,
        signature: info.signature,
      };

      // verify locally before storing
      if (isLicenseValid(license)) {
        await get().license.setLicense(license);
        set(state => { state.license.loading = false; });
        return license;
      }

      set(state => { state.license.loading = false; });
      return null;
    } catch (e) {
      console.warn('[license] fetch failed:', e);
      set(state => { state.license.loading = false; });
      return null;
    }
  },

  setPending: (pending: PendingPayment | null) => {
    set(state => { state.license.pending = pending; });
  },

  clearLicense: async () => {
    await localExtStorage.set('proLicense', undefined);

    set(state => { state.license.license = null; state.license.pending = null; });
  },
});

// selectors
export const licenseSelector = (state: AllSlices) => state.license;
export const isPro = (state: AllSlices): boolean => isLicenseValid(state.license.license);
export const selectPlan = (state: AllSlices): Plan => isPro(state) ? 'pro' : 'free';
export const selectDaysRemaining = (state: AllSlices): number => daysRemaining(state.license.license);
export const selectPending = (state: AllSlices): PendingPayment | null => state.license.pending;
export const canUseFeature = (state: AllSlices, feature: ProFeature): boolean =>
  hasProFeature(state.license.license, feature);
