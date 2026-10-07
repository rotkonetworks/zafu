/**
 * Egress guard for realms with `chrome.storage`: the service worker, popup,
 * side panel and options page. Import FIRST in the entry, before any
 * module that could capture `fetch` or open a socket.
 *
 * Compiles the policy table from storage, recompiles when one of its inputs
 * changes, and serves it to storage-less realms over the channel. Refusals
 * seen here (including those reported by workers) go into the ledger's audit
 * trail so settings can show what zafu declined to contact.
 */

import { CONTACTED_CLEAR, installEgress, onEgressBlocked, onEgressContacted } from './egress';
import { EGRESS_INPUT_KEYS, compileEgress, type EgressInputs } from './egress-policy';
import type { EgressRealm } from './egress-table';

const isServiceWorker = typeof ServiceWorkerGlobalScope !== 'undefined';

const realm: EgressRealm = isServiceWorker
  ? 'service-worker'
  : /\/(popup|sidepanel)\.html$/.test(location.pathname)
    ? 'popup'
    : 'page';

const keys = new Set<string>(EGRESS_INPUT_KEYS);

installEgress(realm, {
  load: async () =>
    compileEgress((await chrome.storage.local.get([...EGRESS_INPUT_KEYS])) as EgressInputs),
  watch: reload =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && Object.keys(changes).some(k => keys.has(k))) {
        reload();
      }
    }),
  // Only the worker can raise the consent window, and only lazily: it pulls in
  // the approval-popup plumbing, which must not load during the worker's
  // synchronous listener registration.
  askUnknown: isServiceWorker
    ? url => import('./adhoc').then(m => m.askAboutUnknownHost(url))
    : undefined,
});

// The service worker keeps the audit trail; other realms' refusals reach it
// over the channel. Lazy for the same reason as above.
if (isServiceWorker) {
  onEgressBlocked(refusal => {
    void import('./ledger').then(m => m.recordRefusal(refusal));
  });
  // and the one writer of what zafu contacted lately (./contacted)
  onEgressContacted(tally => {
    void import('./contacted').then(m => m.noteContacted(tally));
  });
  // "clear this list": what this worker holds unwritten goes with the stored log
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, respond) => {
    if ((msg as { type?: unknown } | null)?.type !== CONTACTED_CLEAR) {
      return false;
    }
    void import('./contacted')
      .then(m => m.clearContacted())
      .then(
        () => respond(true),
        () => respond(false),
      );
    return true;
  });
}
