/**
 * "friends can find you here": the per-site grant for private contact
 * discovery (spec design-social 2.10, founder answer 4: off until the person
 * turns it on). A site may run zafu_discover_contacts only when discovery is
 * on AND this site holds the grant. Kept on the site's own preference
 * (`zidPreferences[origin].findFriends`), so it lives and dies with the site.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZidSitePreference } from './identity';

const DEFAULT_PREF: ZidSitePreference = { mode: 'site', rotation: 0, identity: 'default' };

type Prefs = Record<string, ZidSitePreference>;

export const siteFindsFriends = async (origin: string): Promise<boolean> =>
  ((await localExtStorage.get('zidPreferences')) as Prefs | undefined)?.[origin]?.findFriends ===
  true;

/**
 * Turn the grant on or off for one site. Turning it on also turns discovery
 * on (keeping any relay the person configured); turning it off touches only
 * this site.
 */
export const setSiteFindsFriends = async (origin: string, on: boolean): Promise<void> => {
  const prefs = { ...((await localExtStorage.get('zidPreferences')) as Prefs | undefined) };
  prefs[origin] = { ...(prefs[origin] ?? DEFAULT_PREF), findFriends: on };
  await localExtStorage.set('zidPreferences', prefs);
  if (on) {
    const stored = await localExtStorage.get('zidDiscovery');
    await localExtStorage.set('zidDiscovery', {
      enabled: true,
      relayEndpoint: stored?.relayEndpoint ?? '',
      relayToken: stored?.relayToken ?? '',
    });
  }
};

/** discovery on wallet-wide (the relay may still be refused by the site gate) */
export const discoveryEnabled = async (): Promise<boolean> =>
  (await localExtStorage.get('zidDiscovery'))?.enabled === true;
