/**
 * The edge where {@link nymPlan} meets chrome: the service worker reads the
 * lock (session `passwordKey`) and the compiled egress table, folds them into
 * a plan, and starts or stops the tunnel in the offscreen document. The plan
 * is applied on start and on every change, so a service worker woken later,
 * or an offscreen document Chrome closed, comes back on the next change or the
 * next request (`ensureNym`), without a keep-alive.
 *
 * Every start in the offscreen document asks here first ({@link NYM_MAY_START}),
 * so the plan's vetoes (locked, nym off, nothing to carry) hold for a send's
 * retry or a reroute too, not only for the plan's own starts.
 */

import type { EgressTable } from './egress-table';
import { nymRoutingOn, onEgressTable } from './egress';
import { ensureNym, NYM_MAY_START, postNym } from './nym-bridge';
import { nymPlan, type NymPlan } from './nym-plan';

const EFFECT: Record<NymPlan, () => void> = {
  up: () => void ensureNym(),
  idle: () => postNym({ type: 'stop', idle: true }),
  down: () => postNym({ type: 'stop' }),
  leave: () => undefined,
};

export const startNymLifecycle = (): { lastWindowClosed: () => void } => {
  let table: EgressTable | undefined;
  let unlocked = false;
  let plan: NymPlan | undefined;
  const planOf = (t: EgressTable): NymPlan =>
    nymPlan({
      keepReady: t.nymKeepReady === true,
      up: plan === 'up',
      carries: !!t.nymVia?.length,
      master: t.nym === true,
      unlocked,
    });
  const apply = () => {
    if (!table) {
      return;
    }
    const next = planOf(table);
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
    chrome.storage.session.get('passwordKey').then(r => {
      unlocked = !!r['passwordKey'];
      apply();
    });
  chrome.storage.onChanged.addListener(
    (c, area) => area === 'session' && 'passwordKey' in c && readLock(),
  );
  void readLock();
  // asked fresh, the lock read again: a worker just woken by the ask answers right
  const mayStart = async () => {
    await nymRoutingOn();
    await readLock();
    return !!table && planOf(table) !== 'down';
  };
  chrome.runtime.onMessage.addListener((m: unknown, sender, respond) => {
    if (
      (m as { type?: unknown } | null)?.type !== NYM_MAY_START ||
      sender.id !== chrome.runtime.id
    ) {
      return false;
    }
    void mayStart().then(respond, () => respond(false));
    return true;
  });
  return {
    // on demand, nothing runs while zafu is closed; kept ready, it stays
    lastWindowClosed: () => plan !== 'up' && postNym({ type: 'stop' }),
  };
};
