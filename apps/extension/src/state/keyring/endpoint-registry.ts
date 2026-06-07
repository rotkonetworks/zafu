/**
 * Curated zcash endpoint registry.
 *
 * zidecar entries are the exception (rotko-operated trustless backends).
 * Everything else defaults to lightwalletd (trusted, generic).
 *
 * Users can still type a custom endpoint URL in the settings input - that
 * path stays defensive: hostname-suffix fallback in isZidecarEndpoint
 * classifies a custom URL as zidecar only if it matches rotko.net.
 *
 * Extend this list only after we've shipped a zidecar at the URL in
 * question, or confirmed the lightwalletd is community-trusted.
 */

import type { ZcashBackend } from './zcash-backend';

export interface CuratedEndpoint {
  readonly url: string;
  readonly label: string;
  readonly backend: ZcashBackend;
  readonly operator: string;
}

export const CURATED_ZCASH_ENDPOINTS: ReadonlyArray<CuratedEndpoint> = [
  {
    url: 'https://zcash.rotko.net',
    label: 'rotko zidecar',
    backend: 'zidecar',
    operator: 'rotko.net',
  },
  {
    url: 'https://mainnet.lightwalletd.com:9067',
    label: 'Zashi mainnet',
    backend: 'lightwalletd',
    operator: 'ECC',
  },
];

export function findCuratedEndpoint(url: string): CuratedEndpoint | undefined {
  return CURATED_ZCASH_ENDPOINTS.find(e => e.url === url);
}
