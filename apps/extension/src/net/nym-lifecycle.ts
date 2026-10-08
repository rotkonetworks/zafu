/**
 * The edge where {@link nymPlan} meets chrome: the service worker reads the
 * lock (session `passwordKey`) and the compiled egress table, folds them into
 * a plan, and starts or stops the tunnel in the offscreen document. The plan
 * is applied on start and on every change, so a service worker woken later,
 * or an offscreen document Chrome closed, comes back on the next change or the
 * next request (`ensureNym`), without a keep-alive.
 */

import type { EgressTable } from './egress-table';
import { onEgressTable } from './egress';
import { ensureNym, postNym } from './nym-bridge';
import { nymPlan, type NymPlan } from './nym-plan';

const EFFECT: Record<NymPlan, () => void> = {
  up: () => void ensureNym(),
  down: () => postNym({ type: 'stop' }),
  leave: () => undefined,
};

export const startNymLifecycle = (): { lastWindowClosed: () => void } => {
  let table: EgressTable | undefined;
  let unlocked = false;
  let plan: NymPlan | undefined;
  const apply = () => {
    if (!table) {
      return;
    }
    const next = nymPlan({
      keepReady: table.nymKeepReady === true,
      carries: !!table.nymVia?.length,
      master: table.nym === true,
      unlocked,
    });
    if (next !== plan) {
      plan = next;
      EFFECT[next]();
    }
  };
  onEgressTable(t => {
    table = t;
    apply();
  });
  const readLock = () =>
    void chrome.storage.session.get('passwordKey').then(r => {
      unlocked = !!r['passwordKey'];
      apply();
    });
  chrome.storage.onChanged.addListener(
    (c, area) => area === 'session' && 'passwordKey' in c && readLock(),
  );
  readLock();
  return {
    // on demand, nothing runs while zafu is closed; kept ready, it stays
    lastWindowClosed: () => plan !== 'up' && postNym({ type: 'stop' }),
  };
};
