/**
 * license state - tracks pro subscription status.
 *
 * license is fetched DIRECTLY from rotko's license-server over HTTPS.
 * never through zidecar - keeps license identity separate from sync identity.
 *
 * server is always the source of truth:
 *   - after wallet unlock, fetch license from server
 *   - server reachable + pro → show pro
 *   - server reachable + free → show free
 *   - server unreachable → show free (offline = no pro)
 *
 * sync priority uses ring VRF proofs (anonymous, unlinkable).
 *   free  = normal sync (always works)
 *   pro   = priority queue under load
 */

import type { AllSlices, SliceCreator } from '.';
import {
  isLicenseValid,
  hasProFeature,
  daysRemaining,
  type License,
  type Plan,
  type ProFeature,
} from '@repo/wallet/license';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Direct license-server endpoint - never goes through zidecar.
 *
 * Single named constant on purpose: this host is the only party that ever
 * sees the ZID, so moving it should be exactly one edit.
 *
 * INTENDED TO MOVE to `https://license.zafu.pro`. Not moved yet, on purpose:
 * that DNS record does not resolve at the time of writing, and pointing the
 * unlock path at a dead hostname would fail every license check closed to
 * "free". Flip this string once the record is stood up.
 *
 * Be clear about what that rename would and would not achieve. It does NOT
 * on its own address the correlation problem: if `license.zafu.pro` lands on
 * the same infrastructure, behind the same logging, as the sync endpoint,
 * then the operator still sees a ZID lookup and a nullifier batch arrive
 * from one IP seconds apart and can join them. The rename only helps if the
 * host is genuinely separately operated. The three changes below — ZID out
 * of the URL path, ring pubkey unbundled, identity-rotation limits
 * documented — are what actually reduce exposure, and they hold regardless
 * of where this is hosted.
 */
export const LICENSE_SERVER = 'https://zpro.rotko.net';

/**
 * ── why these are POSTs, not GETs ────────────────────────────────────────
 *
 * The ZID used to travel in the URL path (`GET /license/<zid>`). A URL path
 * is the worst place in an HTTP request to put a stable identifier: it is
 * written to the access log of every proxy, load balancer and CDN on the
 * route, it lands in `Referer` headers, and those logs are retained for far
 * longer, by far more parties, than anything the application itself keeps.
 * A request body is seen by the TLS endpoint and nothing else in between.
 *
 * This does NOT make the request anonymous. The license server still learns
 * the ZID, still sees the source IP, and still sees a request on every
 * unlock. Moving the value out of the path narrows who else gets a copy; it
 * does not narrow what the server itself learns.
 *
 * ⚠ NOTE FOR THE SERVER — THIS IS A BREAKING WIRE-FORMAT CHANGE, AND IT MUST
 * SHIP IN LOCKSTEP WITH THE SERVER. `zpro.rotko.net` must serve
 * `POST /license` and `POST /license/ring` with JSON bodies. The old
 * `GET /license/<zid>` route is no longer called by this client. Until the
 * server accepts POST, every license check will fail and every paying user
 * will silently drop to "free" (the fetch failure path below treats any
 * non-ok response as unlicensed).
 */
const LICENSE_PATH = '/license';
const RING_REGISTER_PATH = '/license/ring';

/**
 * ── on identity rotation ─────────────────────────────────────────────────
 *
 * The value sent here is the PERMANENT, seed-derived cross-site ZID
 * (`deriveZidCrossSite` / the deprecated `deriveZid`), not the rotated one
 * from `rotatedIdentity()`. That means the "burn identity" feature does not
 * change what this server sees: rotate as often as you like, the license
 * server still recognises you.
 *
 * This is deliberate and it is NOT fixable on the client. The subscription
 * is credited on-chain: `buildPaymentMemo(zidPubkey)` puts the permanent
 * cross-site ZID in the payment memo, and the server credits the payment to
 * that exact key. Sending a rotated ZID would look up an identity that never
 * paid, and the user would silently lose the pro license they bought.
 *
 * So: the licensing model, as it stands, REQUIRES the permanent identifier.
 * Making rotation effective here needs a server-side change — a rebinding
 * flow, or moving the lookup to a blinded/anonymous credential — and until
 * that exists, unlocking the wallet tells the license server that this
 * specific seed is online, regardless of ZID rotation.
 */

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

  /**
   * fetch license directly from license-server by ZID pubkey.
   *
   * takes NO ring pubkey, by design — see `registerRing`.
   */
  fetchLicense: (zid: string) => Promise<License | null>;
  /**
   * register the ring-VRF pubkey against a paid ZID.
   *
   * split out of `fetchLicense` deliberately. Bundling the ring pubkey into
   * the license lookup meant the two identifiers travelled together on a
   * request that fires on a subscription poll loop, handing the server the
   * zid↔ring mapping repeatedly and for no reason.
   *
   * Being honest about what the split does and does not buy: registration
   * inherently discloses the mapping, because the server has to know which
   * ring members have paid in order to admit them to the ring at all. The
   * unlinkability the ring VRF provides is against the SYNC service, which
   * sees an anonymous membership proof and never the ZID — not against this
   * server. What the split actually achieves is narrow: the mapping is
   * disclosed once, at subscribe time, instead of on every license check.
   */
  registerRing: (zid: string, ringPubkey: Uint8Array) => Promise<void>;
  /** update pending payment info from server */
  setPending: (pending: PendingPayment | null) => void;
  /** clear license */
  clearLicense: () => void;
}

export const createLicenseSlice = (): SliceCreator<LicenseSlice> => set => ({
  license: null,
  loading: false,
  pending: null,

  registerRing: async (zid: string, ringPubkey: Uint8Array) => {
    try {
      await fetch(new URL(RING_REGISTER_PATH, LICENSE_SERVER).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ zid, ring_pubkey: bytesToHex(ringPubkey) }),
      });
    } catch (e) {
      // registration is best-effort; the license itself does not depend on it
      console.warn('[license] ring registration failed (offline):', e);
    }
  },

  fetchLicense: async (zid: string) => {
    set(state => {
      state.license.loading = true;
    });
    try {
      // ZID in the body, never the path or query — see LICENSE_PATH above.
      const resp = await fetch(new URL(LICENSE_PATH, LICENSE_SERVER).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ zid }),
      });

      if (!resp.ok) {
        set(state => {
          state.license.license = null;
          state.license.loading = false;
        });
        return null;
      }

      const info = (await resp.json()) as {
        zid: string;
        plan: string;
        expires: number;
        signature: string;
      };

      if (!info.signature || info.plan === 'free') {
        set(state => {
          state.license.license = null;
          state.license.loading = false;
        });
        return null;
      }

      const license: License = {
        zid: info.zid,
        plan: info.plan as Plan,
        expires: info.expires,
        signature: info.signature,
      };

      if (isLicenseValid(license)) {
        set(state => {
          state.license.license = license;
          state.license.loading = false;
        });
        return license;
      }

      set(state => {
        state.license.license = null;
        state.license.loading = false;
      });
      return null;
    } catch (e) {
      // server unreachable = offline, treat as free
      console.warn('[license] fetch failed (offline):', e);
      set(state => {
        state.license.license = null;
        state.license.loading = false;
      });
      return null;
    }
  },

  setPending: (pending: PendingPayment | null) => {
    set(state => {
      state.license.pending = pending;
    });
  },

  clearLicense: () => {
    set(state => {
      state.license.license = null;
      state.license.pending = null;
    });
  },
});

// selectors
export const licenseSelector = (state: AllSlices) => state.license;
export const isPro = (state: AllSlices): boolean => isLicenseValid(state.license.license);
export const selectPlan = (state: AllSlices): Plan => (isPro(state) ? 'pro' : 'free');
export const selectDaysRemaining = (state: AllSlices): number =>
  daysRemaining(state.license.license);
export const selectPending = (state: AllSlices): PendingPayment | null => state.license.pending;
export const canUseFeature = (state: AllSlices, feature: ProFeature): boolean =>
  hasProFeature(state.license.license, feature);
