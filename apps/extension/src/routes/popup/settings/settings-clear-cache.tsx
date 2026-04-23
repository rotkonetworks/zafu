import {
  getClearCacheStepLabel,
  type ClearCacheProgress,
  type ClearCacheStep,
} from '../../../message/services';
import { useStore } from '../../../state';
import { selectKeyInfos } from '../../../state/keyring';
import { selectZcashWallets, selectPenumbraWallets } from '../../../state/wallets';
import { terminateNetworkWorker, spawnNetworkWorker } from '../../../state/keyring/network-worker';
import { useState, useEffect } from 'react';
import { SettingsScreen } from './settings-screen';
import type { KeyInfo } from '../../../state/keyring';

interface ClearingState {
  inProgress: boolean;
  step: ClearCacheStep;
  completed: number;
  total: number;
}

const TYPE_LABELS: Record<string, string> = {
  mnemonic: 'seed vaults',
  'zigner-zafu': 'zigner vaults',
  'frost-multisig': 'multisig vaults',
};

const TYPE_ORDER = ['mnemonic', 'zigner-zafu', 'frost-multisig'] as const;

export const SettingsClearCache = () => {
  const keyInfos = useStore(selectKeyInfos);
  const zcashWallets = useStore(selectZcashWallets);
  const penumbraWallets = useStore(selectPenumbraWallets);
  const [clearingKey, setClearingKey] = useState<string | null>(null);

  const [clearingState, setClearingState] = useState<ClearingState>({
    inProgress: false, step: 'stopping', completed: 0, total: 0,
  });

  // listen for progress from service worker
  useEffect(() => {
    const handler = (message: unknown) => {
      if (
        typeof message === 'object' && message !== null &&
        'type' in message && (message as { type: string }).type === 'ClearCacheProgress'
      ) {
        const p = message as ClearCacheProgress;
        setClearingState({ inProgress: true, step: p.step, completed: p.completed, total: p.total });
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const progressPercent = clearingState.total > 0
    ? Math.round((clearingState.completed / clearingState.total) * 100)
    : 0;

  const handleClearZcash = async (_vault: KeyInfo) => {
    setClearingKey(`${_vault.id}:zcash`);
    try {
      // terminate worker so in-memory commitment tree is dropped
      try { terminateNetworkWorker('zcash'); } catch {}
      // delete IndexedDB databases (zcash sync data + memo cache)
      try { indexedDB.deleteDatabase('zafu-zcash'); } catch {}
      try { indexedDB.deleteDatabase('zafu-memo-cache'); } catch {}
      // small delay for IDB deletion to settle
      await new Promise(r => setTimeout(r, 500));
      // respawn worker fresh — sync will restart from birthday
      try { await spawnNetworkWorker('zcash'); } catch {}
    } finally {
      setClearingKey(null);
    }
  };

  const handleClearPenumbra = (_vault: KeyInfo) => {
    setClearingState({ inProgress: true, step: 'stopping', completed: 0, total: 4 });
    // fire-and-forget: service worker will reload the extension when done
    chrome.runtime.sendMessage({ type: 'ClearCache', network: 'penumbra' }).catch(() => {
      // expected — extension reloads before response arrives
    });
  };

  const grouped = TYPE_ORDER
    .map(type => ({
      type,
      label: TYPE_LABELS[type] ?? type,
      vaults: keyInfos.filter(k => k.type === type),
    }))
    .filter(g => g.vaults.length > 0);

  return (
    <SettingsScreen title='clear cache'>
      <div className='flex flex-col gap-4'>
        {clearingState.inProgress ? (
          <div className='flex flex-col gap-3'>
            <div className='h-1.5 w-full rounded-full bg-elev-2 overflow-hidden'>
              <div
                className='h-full bg-zigner-gold transition-all duration-300 ease-out'
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className='flex justify-between text-xs text-fg-muted'>
              <span>{getClearCacheStepLabel(clearingState.step)}</span>
              <span>{progressPercent}%</span>
            </div>
            <p className='text-[10px] text-fg-muted'>
              do not close the extension.
            </p>
          </div>
        ) : (
          <>
            <div className='flex flex-col gap-3'>
              <p className='text-sm text-fg-muted'>
                clears sync data per network and resynchronizes from chain.
              </p>
              <p className='flex items-center gap-2 text-xs text-rust'>
                <span className='i-lucide-triangle-alert size-4' />
                your private keys won't be lost
              </p>
            </div>

            {grouped.map(g => (
              <div key={g.type}>
                <p className='mb-2 text-xs font-medium text-fg-muted uppercase tracking-wider'>{g.label}</p>
                <div className='flex flex-col divide-y divide-border/40 rounded-lg border border-border-hard-soft bg-elev-1'>
                  {g.vaults.map(v => {
                    const hasZcash = zcashWallets.some(w => w.vaultId === v.id) || v.type === 'mnemonic';
                    const hasPenumbra = penumbraWallets.some(w => w.vaultId === v.id) || v.type === 'mnemonic';

                    return (
                      <div key={v.id} className='px-3 py-2.5'>
                        <p className='text-sm truncate'>{v.name}</p>
                        <div className='flex gap-2 mt-1.5'>
                          {hasZcash && (
                            <button
                              disabled={!!clearingKey || clearingState.inProgress}
                              onClick={() => void handleClearZcash(v)}
                              className='rounded border border-red-500/25 bg-red-500/5 px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/15 transition-colors disabled:opacity-50'
                            >
                              {clearingKey === `${v.id}:zcash` ? 'clearing...' : 'clear zcash'}
                            </button>
                          )}
                          {hasPenumbra && (
                            <button
                              disabled={!!clearingKey || clearingState.inProgress}
                              onClick={() => void handleClearPenumbra(v)}
                              className='rounded border border-red-500/25 bg-red-500/5 px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/15 transition-colors disabled:opacity-50'
                            >
                              {clearingKey === `${v.id}:penumbra` ? 'clearing...' : 'clear penumbra'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </SettingsScreen>
  );
};
