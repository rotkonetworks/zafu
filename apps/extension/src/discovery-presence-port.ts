/**
 * Worker side of discovery presence: the one live driver, the ports granted
 * pages hold, and the storage changes that start or stop them.
 *
 *  - a page holds presence over DISCOVERY_HOLD_PORT, opened by its content
 *    script only after the worker asks it to (`holdTab`): when the site was
 *    served friends or the person said yes to it, or when the person turns
 *    "friends can find you here" on while the site is open;
 *  - the port's attested sender is the site; a site without the grant is
 *    told to stop and dropped;
 *  - the page's heartbeat ticks the 5-minute beacon; the port closing (tab
 *    closed, navigated, back/forward cache) ends it;
 *  - a grant taken away, or discovery turned off, withdraws this window's
 *    beacon and drops the site's ports at once.
 *
 * No alarm, and nothing on worker start: with no granted page open, nothing
 * here touches the network.
 */

import { isValidExternalSender } from './senders/external';
import { contactDiscoveryDeps } from './state/contact-discovery-service';
import { createDiscoveryPresence, type PresenceHold } from './state/discovery-presence';
import type { ZidSitePreference } from './state/identity';
import {
  DISCOVERY_HOLD_MESSAGE,
  DISCOVERY_HOLD_PORT,
  DISCOVERY_HOLD_STOP,
} from './discovery-hold-names';

export const discoveryPresence = createDiscoveryPresence(contactDiscoveryDeps);

/** ask this tab's page to hold presence (it opens the port; the worker checks the grant) */
export const holdTab = (tabId: number | undefined): void => {
  if (tabId === undefined) {
    return;
  }
  void chrome.tabs.sendMessage(tabId, { type: DISCOVERY_HOLD_MESSAGE }).catch(() => undefined);
};

type Prefs = Record<string, ZidSitePreference> | undefined;

/** sites whose grant went from off to on in this change */
const newlyGranted = (change: chrome.storage.StorageChange): string[] => {
  const before = change.oldValue as Prefs;
  const after = change.newValue as Prefs;
  return Object.keys(after ?? {}).filter(
    o => after?.[o]?.findFriends === true && before?.[o]?.findFriends !== true,
  );
};

/** every open top-level tab of these sites holds presence */
const holdOpenTabs = async (origins: string[]): Promise<void> => {
  if (!origins.length) {
    return;
  }
  for (const tab of await chrome.tabs.query({})) {
    try {
      if (tab.url && origins.includes(new URL(tab.url).origin)) {
        holdTab(tab.id);
      }
    } catch {
      // not a url a site lives at
    }
  }
};

/** Service-worker side. Call once at worker startup. */
export const startDiscoveryPresence = (): void => {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== DISCOVERY_HOLD_PORT) {
      return;
    }
    const sender = port.sender;
    if (!isValidExternalSender(sender)) {
      port.disconnect();
      return;
    }
    const origin = sender.origin;
    const hold: PresenceHold = {
      close: () => {
        try {
          port.postMessage(DISCOVERY_HOLD_STOP);
          port.disconnect();
        } catch {
          // already gone
        }
      },
    };
    port.onDisconnect.addListener(() => discoveryPresence.release(origin, hold));
    port.onMessage.addListener(() => void discoveryPresence.tick());
    void discoveryPresence.hold(origin, hold).then(kept => {
      if (kept) {
        try {
          port.postMessage('held');
        } catch {
          discoveryPresence.release(origin, hold);
        }
      }
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return;
    }
    const prefs = changes['zidPreferences'];
    if (prefs || changes['zidDiscovery']) {
      void discoveryPresence.recheck();
    }
    if (prefs) {
      void holdOpenTabs(newlyGranted(prefs));
    }
  });
};
