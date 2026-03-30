/**
 * license state - tracks pro subscription status.
 *
 * license is fetched from zidecar, verified against rotko's key,
 * stored in localStorage. checked on feature access.
 *
 * rate-limit tier: license signature is attached to all gRPC requests
 * via x-zafu-license header. zidecar verifies and applies tiers:
 *   free  = throttled sync (entry level, always works)
 *   pro   = full speed, priority
 */

import type { AllSlices, SliceCreator } from '.';
import { isLicenseValid, hasProFeature, daysRemaining, parseLicense, type License, type Plan, type ProFeature } from '@repo/wallet/license';
import { localExtStorage } from '@repo/storage-chrome/local';
import { ZidecarClient } from './keyring/zidecar-client';

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
  /** fetch license from zidecar by ZID pubkey, optionally registering ring pubkey */
  fetchLicense: (zidecarUrl: string, zid: string, ringPubkey?: Uint8Array) => Promise<License | null>;
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

  fetchLicense: async (zidecarUrl: string, zid: string, ringPubkey?: Uint8Array) => {
    set(state => { state.license.loading = true; });
    try {
      const client = new ZidecarClient(zidecarUrl);
      const info = await client.checkLicense(zid, ringPubkey);

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
