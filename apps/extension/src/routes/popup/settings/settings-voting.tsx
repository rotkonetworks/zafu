/**
 * Voting endpoints settings.
 *
 * Shows the currently-resolved vote-server + PIR endpoints (read-only,
 * from either the bundled hash-pinned default or an active override), and
 * lets a user opt into a custom voting config source - a last-resort
 * escape hatch if a Chrome Web Store update can't ship in time, and for
 * pointing the voting UI at a local dev rig.
 *
 * Mirrors settings-rpc.tsx's shape (default-vs-custom endpoint) but for
 * the voting config chain: pinned static config -> dynamic_config_url ->
 * { vote_servers, pir_endpoints }. See services/voting/api.ts for the
 * exact security scoping this override relaxes (https-only, sha256).
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import { loadVoting } from '../../../services/voting/api';
import { resolveVotingConfigSource } from '../../../services/voting/resolve';
import { BUNDLED_PINNED_SOURCE } from '../../../services/voting/types';
import type { ServiceEndpoint } from '../../../services/voting/types';
import { SettingsScreen } from './settings-screen';
import { ToggleSwitch } from '../../../components/toggle-switch';

interface VotingConfigOverride {
  enabled: boolean;
  url: string;
  sha256: string | null;
}

const EMPTY_OVERRIDE: VotingConfigOverride = { enabled: false, url: '', sha256: null };

function EndpointList({ title, endpoints }: { title: string; endpoints: ServiceEndpoint[] }) {
  return (
    <div>
      <p className='kicker px-0 pb-1'>{title}</p>
      {endpoints.length === 0 ? (
        <p className='text-label text-fg-dim'>none</p>
      ) : (
        <div className='flex flex-col gap-1'>
          {endpoints.map(e => (
            <div
              key={e.url}
              className='rounded border border-border-soft/40 bg-elev-1 px-2 py-1.5'
            >
              <p className='text-data text-fg-high'>{e.label || e.url}</p>
              <p className='break-all text-label text-fg-muted'>{e.url}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const SettingsVoting = () => {
  const [override, setOverride] = useState<VotingConfigOverride>(EMPTY_OVERRIDE);
  const [loaded, setLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [sha256Input, setSha256Input] = useState('');
  const [enabledInput, setEnabledInput] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void localExtStorage.get('votingConfigOverride').then(stored => {
      const next = stored ?? EMPTY_OVERRIDE;
      setOverride(next);
      setUrlInput(next.url);
      setSha256Input(next.sha256 ?? '');
      setEnabledInput(next.enabled);
      setAdvancedOpen(next.enabled);
      setLoaded(true);
    });
  }, []);

  const resolvedQ = useQuery({
    // re-resolve after save/reset by keying on the persisted override
    queryKey: ['zcash-vote', 'settings-resolved', override.enabled, override.url, override.sha256],
    enabled: loaded,
    staleTime: 30_000,
    queryFn: () => resolveVotingConfigSource().then(loadVoting),
  });

  const usingOverride = override.enabled && !!override.url;

  const save = async () => {
    setSaveError(null);
    const trimmedUrl = urlInput.trim();
    if (enabledInput && !trimmedUrl) {
      setSaveError('url is required to enable a custom voting config source');
      return;
    }
    const next: VotingConfigOverride = {
      enabled: enabledInput,
      url: trimmedUrl,
      sha256: sha256Input.trim() || null,
    };
    await localExtStorage.set('votingConfigOverride', next);
    setOverride(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const resetToDefault = async () => {
    setSaveError(null);
    await localExtStorage.set('votingConfigOverride', EMPTY_OVERRIDE);
    setOverride(EMPTY_OVERRIDE);
    setUrlInput('');
    setSha256Input('');
    setEnabledInput(false);
  };

  return (
    <SettingsScreen title='voting endpoints'>
      <div className='flex flex-col gap-5'>
        <div>
          <p className='text-data text-fg-high'>
            source: {usingOverride ? 'custom override' : 'default (bundled, sha256-pinned)'}
          </p>
          {!usingOverride && (
            <p className='mt-0.5 break-all text-label text-fg-dim'>{BUNDLED_PINNED_SOURCE.url}</p>
          )}
          {usingOverride && (
            <p className='mt-0.5 break-all text-label text-fg-dim'>{override.url}</p>
          )}
        </div>

        {resolvedQ.isLoading && (
          <p className='text-label text-fg-muted'>loading current endpoints...</p>
        )}

        {resolvedQ.error && (
          <p className='text-label text-red-400'>
            failed to load: {resolvedQ.error instanceof Error ? resolvedQ.error.message : String(resolvedQ.error)}
          </p>
        )}

        {resolvedQ.data && (
          <div className='flex flex-col gap-3'>
            <EndpointList title='vote servers' endpoints={resolvedQ.data.config.vote_servers} />
            <EndpointList title='pir endpoints' endpoints={resolvedQ.data.config.pir_endpoints} />
          </div>
        )}

        <div className='border-t border-border-soft pt-4'>
          <button
            type='button'
            onClick={() => setAdvancedOpen(v => !v)}
            className='flex w-full items-center justify-between text-left'
          >
            <span className='flex items-center gap-2 text-data text-fg-high'>
              <span className='i-lucide-triangle-alert size-4 text-fg-muted' />
              advanced: custom voting config source
            </span>
            <span
              className={`i-lucide-chevron-down size-4 text-fg-muted transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {advancedOpen && (
            <div className='mt-3 flex flex-col gap-3'>
              <div className='rounded border border-red-400/30 bg-red-400/5 px-3 py-2'>
                <p className='text-label text-red-400'>
                  warning - a custom or malicious voting/PIR server can deanonymize your vote or
                  serve invalid data. only point this at a source you trust: a build you control,
                  or a local dev rig. leave this off otherwise.
                </p>
              </div>

              <div className='flex items-center justify-between gap-4'>
                <div>
                  <p className='text-sm font-medium'>enable override</p>
                  <p className='mt-0.5 text-xs text-fg-muted'>
                    replaces the bundled default for this device only
                  </p>
                </div>
                <ToggleSwitch checked={enabledInput} onChange={setEnabledInput} label='enable override' />
              </div>

              <label className='flex flex-col gap-1'>
                <span className='text-label text-fg-muted'>static config url</span>
                <input
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  placeholder='https://example.com/static-voting-config.json'
                  className='w-full rounded border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono outline-none focus:border-zigner-gold'
                />
                <span className='text-label text-fg-dim'>
                  https:// required, or http://localhost / http://127.0.0.1 for a local dev rig
                </span>
              </label>

              <label className='flex flex-col gap-1'>
                <span className='text-label text-fg-muted'>sha256 (optional)</span>
                <input
                  value={sha256Input}
                  onChange={e => setSha256Input(e.target.value)}
                  placeholder='lowercase hex - leave blank to skip verification'
                  className='w-full rounded border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono outline-none focus:border-zigner-gold'
                />
                <span className='text-label text-fg-dim'>
                  if set, the fetched config is checksum-verified against this before use
                </span>
              </label>

              {saveError && <p className='text-label text-red-400'>{saveError}</p>}
              {saved && <p className='text-label text-fg-high'>saved</p>}

              <div className='flex gap-2'>
                <button
                  onClick={() => void save()}
                  className='flex-1 rounded border border-network-accent bg-network-accent px-3 py-1.5 text-data text-network-accent-foreground'
                >
                  save
                </button>
                <button
                  onClick={() => void resetToDefault()}
                  className='flex-1 rounded border border-border-soft px-3 py-1.5 text-data text-fg-muted hover:text-fg-high'
                >
                  reset to default
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsScreen>
  );
};
