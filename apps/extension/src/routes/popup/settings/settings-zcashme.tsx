/**
 * zcash.me directory settings.
 *
 * Opt-in only. Default is off: no request ever goes to zcash.me until the
 * user picks a mode here. The two modes differ in what the server learns:
 *
 *   directory  one bulk download of the public directory; every name and
 *              address lookup afterwards is a local map read. zcash.me
 *              learns that you use the feature, not who you pay.
 *   live       "/name" is resolved per request via the public endpoint;
 *              zcash.me sees your ip and every name you look up.
 *
 * The bulk endpoint is api-key gated and the key is one global server
 * secret, so it is never bundled. Two ways to get a snapshot: paste your
 * own key (ask james@zcash.me), or point at a mirror that republishes the
 * directory as json.
 */

import { useEffect, useState } from 'react';
import { SettingsScreen } from './settings-screen';
import {
  DEFAULT_LIVE_DECOYS,
  DEFAULT_ZCASHME_CONFIG,
  readZcashMeConfig,
  writeZcashMeConfig,
  type ZcashMeConfig,
  type ZcashMeMode,
} from '../../../services/zcashme/config';
import {
  clearDirectorySnapshot,
  getDirectoryIndex,
  loadDirectoryIndex,
  onDirectoryChange,
  refreshDirectoryFromApi,
  refreshDirectoryFromMirror,
  type DirectoryIndex,
} from '../../../services/zcashme/directory';
import { MAX_DECOYS } from '../../../services/zcashme/decoys';
import { cn } from '@repo/ui/lib/utils';

const MODES: { value: ZcashMeMode; label: string; detail: string }[] = [
  { value: 'off', label: 'off', detail: 'nothing leaves the wallet (default)' },
  {
    value: 'directory',
    label: 'local directory',
    detail: 'download the whole directory once; lookups and counterparty labels stay local',
  },
  {
    value: 'live',
    label: 'live lookup',
    detail: 'resolve /name on demand - zcash.me sees your ip and each name you look up',
  },
];

const inputCls =
  'w-full rounded-lg border border-border-soft bg-input px-3 py-2 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-network-accent focus:outline-none';

const fmtAge = (ms: number): string => {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 60) {
    return `${min} min ago`;
  }
  const h = Math.round(min / 60);
  if (h < 48) {
    return `${h} h ago`;
  }
  return `${Math.round(h / 24)} d ago`;
};

export function SettingsZcashMe() {
  const [config, setConfig] = useState<ZcashMeConfig>(DEFAULT_ZCASHME_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState<DirectoryIndex | null>(getDirectoryIndex());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void readZcashMeConfig().then(c => {
      setConfig(c);
      setLoaded(true);
    });
    void loadDirectoryIndex().then(setIndex);
    return onDirectoryChange(() => setIndex(getDirectoryIndex()));
  }, []);

  const persist = async (next: ZcashMeConfig) => {
    setConfig(next);
    await writeZcashMeConfig(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const refresh = async () => {
    setError(null);
    const mirror = config.mirrorUrl.trim();
    const key = config.apiKey.trim();
    if (!mirror && !key) {
      setError('add a mirror url or an api key first');
      return;
    }
    try {
      if (mirror) {
        setBusy('downloading snapshot...');
        await refreshDirectoryFromMirror(mirror);
      } else {
        setBusy('fetching directory...');
        await refreshDirectoryFromApi(key, {
          onProgress: p => setBusy(`fetching directory... ${p.profiles} profiles`),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setError(null);
    await clearDirectorySnapshot();
  };

  if (!loaded) {
    return (
      <SettingsScreen title='zcash.me directory'>
        <p className='text-label text-fg-muted'>loading...</p>
      </SettingsScreen>
    );
  }

  const verifiedCount = index ? index.snapshot.profiles.filter(p => p.addressVerified).length : 0;

  return (
    <SettingsScreen title='zcash.me directory'>
      <div className='flex flex-col gap-5'>
        <p className='text-label text-fg-muted'>
          zcash.me maps usernames and verified social handles (x, github, telegram...) to zcash
          addresses. with it on, you can pay /username and the wallet can name the addresses you
          already paid.
        </p>

        <div className='flex flex-col gap-2'>
          <p className='kicker px-0'>mode</p>
          {MODES.map(m => (
            <button
              key={m.value}
              type='button'
              onClick={() =>
                void persist({
                  ...config,
                  mode: m.value,
                  decoys:
                    m.value === 'live' && config.decoys === 0 ? DEFAULT_LIVE_DECOYS : config.decoys,
                })
              }
              className={cn(
                'flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors',
                config.mode === m.value
                  ? 'border-network-accent bg-elev-1'
                  : 'border-border-soft hover:bg-elev-1',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  config.mode === m.value
                    ? 'i-ph-radio-button-fill text-network-accent'
                    : 'i-ph-circle text-fg-muted',
                )}
              />
              <span className='flex flex-col'>
                <span className='text-xs text-fg-high'>{m.label}</span>
                <span className='text-label text-fg-muted'>{m.detail}</span>
              </span>
            </button>
          ))}
          {saved && <p className='text-label text-fg-dim'>saved</p>}
        </div>

        {config.mode === 'live' && (
          <div className='flex flex-col gap-2'>
            <p className='kicker px-0'>lookup cover (decoys)</p>
            <p className='text-label text-fg-muted'>
              fire around this many real decoy names from the snapshot alongside each live lookup,
              in one spaced burst, so zcash.me cannot tell which name you want. the exact count is
              randomised per lookup so the burst size is not a fixed tell. needs a snapshot to draw
              real decoys from. it still sees your ip, and the same name looked up across sessions
              can be correlated - {'\u0030'} keeps lookups bare.
            </p>
            <div className='flex items-center gap-2'>
              <input
                type='range'
                min={0}
                max={MAX_DECOYS}
                step={1}
                value={Math.min(config.decoys, MAX_DECOYS)}
                onChange={e => void persist({ ...config, decoys: Number(e.target.value) })}
                className='flex-1 accent-network-accent'
              />
              <span className='w-16 text-right text-xs text-fg-high'>
                {config.decoys === 0 ? 'off' : `~${config.decoys}`}
              </span>
            </div>
            {config.decoys > 0 && !index && (
              <p className='text-label text-amber-400'>
                no snapshot loaded - decoys are inactive until you download the directory below.
              </p>
            )}
          </div>
        )}

        {config.mode !== 'off' && (
          <div className='flex flex-col gap-3'>
            <p className='kicker px-0'>directory snapshot</p>
            <div className='rounded-lg border border-border-soft p-2.5 text-label'>
              {index ? (
                <>
                  <p className='text-fg-high'>
                    {index.snapshot.profiles.length} profiles, {verifiedCount} verified
                  </p>
                  <p className='text-fg-muted'>
                    fetched {fmtAge(index.snapshot.fetchedAt)} from{' '}
                    {index.snapshot.source === 'api' ? 'zcash.me api' : index.snapshot.source}
                  </p>
                </>
              ) : (
                <p className='text-fg-muted'>
                  no snapshot yet
                  {config.mode === 'directory'
                    ? ' - /name lookups will find nothing until one is downloaded'
                    : ''}
                </p>
              )}
            </div>

            <div>
              <label className='mb-1 block text-label text-fg-muted'>
                mirror url (snapshot json)
              </label>
              <input
                type='url'
                value={config.mirrorUrl}
                onChange={e => setConfig({ ...config, mirrorUrl: e.target.value })}
                onBlur={() => void persist(config)}
                placeholder='https://.../zcashme-directory.json'
                className={inputCls}
              />
            </div>
            <div>
              <label className='mb-1 block text-label text-fg-muted'>
                or your own zcash.me api key (used only when no mirror is set)
              </label>
              <input
                type='password'
                value={config.apiKey}
                onChange={e => setConfig({ ...config, apiKey: e.target.value })}
                onBlur={() => void persist(config)}
                placeholder='X-API-Key'
                autoComplete='off'
                className={inputCls}
              />
              <p className='mt-1 text-label text-fg-dim'>
                the key is stored on this device only and sent only to zcash.me. keys are issued by
                the zcash.me team.
              </p>
            </div>

            <div className='flex gap-2'>
              <button
                type='button'
                disabled={!!busy}
                onClick={() => void refresh()}
                className='flex-1 rounded-lg bg-network-accent py-2 text-xs font-medium text-network-accent-foreground transition-colors hover:opacity-90 disabled:opacity-50'
              >
                {busy ?? (index ? 'refresh directory' : 'download directory')}
              </button>
              {index && (
                <button
                  type='button'
                  disabled={!!busy}
                  onClick={() => void clear()}
                  className='rounded-lg border border-border-soft px-3 py-2 text-xs text-fg-muted transition-colors hover:text-fg-high disabled:opacity-50'
                >
                  delete
                </button>
              )}
            </div>
            {error && <p className='text-label text-red-400'>{error}</p>}
          </div>
        )}

        <p className='text-label text-fg-dim'>
          an unverified profile has not proven it controls its address. the wallet marks those and
          asks you to confirm with the person before sending.
        </p>
      </div>
    </SettingsScreen>
  );
}
