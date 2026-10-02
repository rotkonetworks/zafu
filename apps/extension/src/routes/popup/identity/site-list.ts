import { useCallback, useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { getAllPermissions } from '@repo/storage-chrome/origin';
import type { OriginPermissions } from '@repo/storage-chrome/capabilities';
import type { ZidShareRecord, ZidSitePreference } from '../../../state/identity';

export interface SiteIdentity {
  origin: string;
  pref: ZidSitePreference;
  /** newest last */
  shares: ZidShareRecord[];
  perms?: OriginPermissions;
  connected: boolean;
  /** first time this site saw you (a share, a grant or nothing known) */
  since?: number;
}

export const DEFAULT_PREF: ZidSitePreference = { mode: 'site', rotation: 0, identity: 'default' };

export const hostOf = (origin: string): string =>
  origin.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** "knows you as player 7f3a": the site's own name for you, else what it holds, and 4 hex of that key */
export const knownLine = (s: SiteIdentity): string => {
  const key = s.shares[s.shares.length - 1]?.publicKey.slice(0, 4);
  const role =
    s.perms?.displayName ?? (s.perms?.granted.includes('passkey') ? 'passkey' : undefined);
  if (!role && !key) {
    return 'knows your wallet';
  }
  return `knows you as ${[role ?? 'you', key].filter(Boolean).join(' ')}`;
};

/**
 * Every site that knows something of you: a key it was handed (the share
 * log), a grant (permissions, incl. a passkey), a per-site preference, or a
 * connection. Read from storage on mount and on `reload()`.
 */
export const useSites = () => {
  const [sites, setSites] = useState<SiteIdentity[]>([]);
  const [log, setLog] = useState<ZidShareRecord[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    void (async () => {
      const [prefs, shareLog, known, perms] = await Promise.all([
        localExtStorage.get('zidPreferences') as Promise<
          Record<string, ZidSitePreference> | undefined
        >,
        localExtStorage.get('zidShareLog') as Promise<ZidShareRecord[] | undefined>,
        localExtStorage.get('knownSites') as Promise<
          { origin: string; choice: string }[] | undefined
        >,
        getAllPermissions(),
      ]);
      const shares = Array.isArray(shareLog) ? shareLog : [];
      const approved = new Set(
        (Array.isArray(known) ? known : []).filter(k => k.choice === 'Approved').map(k => k.origin),
      );
      const origins = new Set([
        ...Object.keys(prefs ?? {}),
        ...shares.map(r => r.sharedWith),
        ...perms.map(p => p.origin),
        ...approved,
      ]);
      setLog(shares);
      setSites(
        [...origins]
          .map(origin => {
            const mine = shares.filter(r => r.sharedWith === origin);
            const p = perms.find(x => x.origin === origin);
            return {
              origin,
              pref: prefs?.[origin] ?? DEFAULT_PREF,
              shares: mine,
              perms: p,
              connected: approved.has(origin),
              since: mine[0]?.sharedAt ?? p?.grantedAt,
            };
          })
          .sort(
            (a, b) =>
              (b.shares.at(-1)?.sharedAt ?? b.since ?? 0) -
              (a.shares.at(-1)?.sharedAt ?? a.since ?? 0),
          ),
      );
    })();
  }, [tick]);

  return { sites, log, reload: useCallback(() => setTick(t => t + 1), []) };
};

/** write one site's preference (undefined = back to the default) */
export const setSitePref = async (origin: string, next: ZidSitePreference | undefined) => {
  const prefs = {
    ...((await localExtStorage.get('zidPreferences')) as
      | Record<string, ZidSitePreference>
      | undefined),
  };
  if (next) {
    prefs[origin] = next;
  } else {
    delete prefs[origin];
  }
  await localExtStorage.set('zidPreferences', prefs);
};

export const shortDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' }).toLowerCase();
