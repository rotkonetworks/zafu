/**
 * Harness-only fixture: seeds a store-backed approval slice with sample data
 * when the window is opened with `?fixture=1` and nothing is pending.
 *
 * origin.tsx and sign.tsx read their request from zustand, populated by the
 * service worker's message listener calling `acceptRequest`, never from the
 * URL - so the screenshot harness has no real site to drive them with. This
 * hook calls the SAME `acceptRequest` a real request would, so the rendered
 * screen is the real component on real (if invented) data, not a mock.
 *
 * It never fires once a real request is pending, and no production caller
 * ever adds `?fixture=1` to these URLs, so this path is inert outside the
 * harness.
 */
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

export const useApprovalFixture = (hasPending: boolean, seed: () => void) => {
  const [params] = useSearchParams();
  const wantsFixture = params.get('fixture') === '1';

  useEffect(() => {
    if (wantsFixture && !hasPending) {
      seed();
    }
  }, [wantsFixture, hasPending, seed]);
};
