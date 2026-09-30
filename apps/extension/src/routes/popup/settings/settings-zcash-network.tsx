import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectKeyInfos } from '../../../state/keyring';
import { selectZcashWallets } from '../../../state/wallets';
import { networksSelector } from '../../../state/networks';
import { findPresetByUrl } from '../../../config/zcash-endpoints';
import { terminateNetworkWorker, spawnNetworkWorker } from '../../../state/keyring/network-worker';
import { deleteZcashDatabases } from '../../../clear-cache-startup';
import { getClearCacheStepLabel, type ClearCacheProgress } from '../../../message/services';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { formatBlockMonth } from '../../../utils/zcash-blocks';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';

/** the lowest set birthday across zcash vaults - "auto" reads from the tip
 *  and misses nothing a fresh vault needs, so it is a fine default, not a
 *  gap to warn about. */
const useEarliestBirthday = (vaultIds: readonly string[]): number | null => {
  const [min, setMin] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void chrome.storage.local
      .get(vaultIds.map(id => `zcashBirthday_${id}`))
      .then(r => {
        if (!live) {
          return;
        }
        const heights = Object.values(r).map(v => Number(v)).filter(n => Number.isFinite(n));
        setMin(heights.length ? Math.min(...heights) : null);
      });
    return () => {
      live = false;
    };
  }, [vaultIds.join(',')]);
  return min;
};

/**
 * Zcash network screen (SetSync.dc.html): status, starts-from, node, then
 * one honest resync action. "sync again from the start" resyncs zcash for
 * every wallet on this computer (the note database is shared across
 * vaults) - the confirm Sheet says so plainly.
 */
export const SettingsZcashNetwork = () => {
  const navigate = usePopupNav();
  const rawNavigate = useNavigate();
  const keyInfos = useStore(selectKeyInfos);
  const zcashWallets = useStore(selectZcashWallets);
  const { networks } = useStore(networksSelector);
  const { latestBlockHeight, fullSyncHeight, error } = useSyncProgress();

  const zcashVaultIds = keyInfos
    .filter(v => v.type === 'mnemonic' || zcashWallets.some(w => w.vaultId === v.id))
    .map(v => v.id);
  const birthday = useEarliestBirthday(zcashVaultIds);

  const endpoint = networks.zcash?.endpoint;
  const preset = endpoint ? findPresetByUrl(endpoint) : undefined;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState<ClearCacheProgress | null>(null);
  const [resyncing, setResyncing] = useState(false);

  useEffect(() => {
    const handler = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'ClearCacheProgress'
      ) {
        setProgress(message as ClearCacheProgress);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const startResync = async () => {
    setConfirmOpen(false);
    setResyncing(true);
    try {
      try {
        terminateNetworkWorker('zcash');
      } catch {}
      await deleteZcashDatabases();
      try {
        await spawnNetworkWorker('zcash');
      } catch {}
    } finally {
      setResyncing(false);
      setProgress(null);
    }
  };

  const behind =
    latestBlockHeight != null && fullSyncHeight != null
      ? Math.max(0, Number(latestBlockHeight) - Number(fullSyncHeight))
      : null;
  const syncing = resyncing || (behind != null && behind > 10);
  const pct =
    latestBlockHeight && fullSyncHeight
      ? Math.min(100, Math.round((Number(fullSyncHeight) / Number(latestBlockHeight)) * 100))
      : undefined;

  const statusLabel = error
    ? 'sync error'
    : resyncing
      ? (progress ? getClearCacheStepLabel(progress.step) : 'resyncing')
      : syncing
        ? 'syncing'
        : fullSyncHeight != null
          ? 'up to date'
          : 'connecting';

  const statusMeta = fullSyncHeight != null ? `block ${Number(fullSyncHeight).toLocaleString()}` : '';

  return (
    <SettingsScreen title='zcash' backPath={PopupPath.SETTINGS_NETWORKS_HOME}>
      <div className='flex flex-col gap-5'>
        <div>
          <p className='kicker mb-2'>sync</p>
          <StatusSlot tone={error ? 'danger' : syncing ? 'gold' : 'info'} progress={pct}>
            <span className='text-fg-high'>{statusLabel}</span>
            {statusMeta && <span className='text-fg-muted'>{statusMeta}</span>}
          </StatusSlot>
          <RowGroup className='mt-2'>
            <Row
              type='value'
              label='starts from'
              value={birthday != null ? formatBlockMonth(birthday) : 'auto'}
              onPress={() => navigate(PopupPath.SETTINGS_WALLETS)}
            />
            <Row
              type='value'
              label='node'
              value={preset?.label ?? (endpoint ? 'custom' : 'auto')}
              onPress={() => rawNavigate(`${PopupPath.SETTINGS_NETWORKS}?network=zcash`)}
            />
          </RowGroup>
        </div>

        <div>
          <p className='kicker mb-2'>if something looks wrong</p>
          <RowGroup>
            <Row
              type='value'
              label='sync again from the start'
              description='for a missing payment or a wrong balance'
              onPress={() => !resyncing && setConfirmOpen(true)}
              disabled={resyncing}
            />
          </RowGroup>
        </div>
      </div>

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen} title='sync zcash again?'>
        <div className='flex flex-col gap-3'>
          <p className='text-sm text-fg'>
            this resyncs zcash for every wallet on this computer, each read again from its own
            start. your keys and your zec are not touched.
          </p>
          <div className='flex justify-between text-xs text-fg-muted'>
            <span>you can keep using zafu</span>
          </div>
          <div className='flex gap-2 pt-1'>
            <Button variant='secondary' size='md' className='w-28' onClick={() => setConfirmOpen(false)}>
              not now
            </Button>
            <Button variant='primary' size='md' className='flex-1' onClick={() => void startResync()}>
              sync again
            </Button>
          </div>
        </div>
      </Sheet>
    </SettingsScreen>
  );
};
