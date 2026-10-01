import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { selectKeyInfos } from '../../../state/keyring';
import { selectZcashWallets } from '../../../state/wallets';
import { networksSelector } from '../../../state/networks';
import { terminateNetworkWorker, spawnNetworkWorker } from '../../../state/keyring/network-worker';
import { deleteZcashDatabases } from '../../../clear-cache-startup';
import { getClearCacheStepLabel, type ClearCacheProgress } from '../../../message/services';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { formatBlockMonth } from '../../../utils/zcash-blocks';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { Row } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';

/** the lowest set birthday across zcash vaults - "auto" reads from the tip
 *  and misses nothing a fresh vault needs, so it is a fine default, not a
 *  gap to warn about. */
const useEarliestBirthday = (vaultIds: readonly string[]): number | null => {
  const [min, setMin] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void chrome.storage.local.get(vaultIds.map(id => `zcashBirthday_${id}`)).then(r => {
      if (!live) {
        return;
      }
      const heights = Object.values(r)
        .map(v => Number(v))
        .filter(n => Number.isFinite(n));
      setMin(heights.length ? Math.min(...heights) : null);
    });
    return () => {
      live = false;
    };
  }, [vaultIds.join(',')]);
  return min;
};

/**
 * zcash network screen (SetSync.dc.html). heights come from the zcash worker
 * and the zcash node the home screen already asks; "sync again from the
 * start" resyncs every wallet on this computer (the note database is shared).
 */
export const SettingsZcashNetwork = () => {
  const navigate = usePopupNav();
  const rawNavigate = useNavigate();
  const keyInfos = useStore(selectKeyInfos);
  const zcashWallets = useStore(selectZcashWallets);
  const { networks } = useStore(networksSelector);
  const { workerSyncHeight, workerChainHeight, chainTip, failure } = useZcashSyncStatus();

  const zcashVaultIds = keyInfos
    .filter(v => v.type === 'mnemonic' || zcashWallets.some(w => w.vaultId === v.id))
    .map(v => v.id);
  const birthday = useEarliestBirthday(zcashVaultIds);

  const endpoint = networks.zcash?.endpoint;

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

  const tip = chainTip?.height || workerChainHeight;
  const behind = tip && workerSyncHeight ? Math.max(0, tip - workerSyncHeight) : null;
  const syncing = resyncing || (behind != null && behind > 10);
  const pct =
    syncing && tip ? Math.min(100, Math.round((workerSyncHeight / tip) * 100)) : undefined;

  const status = resyncing
    ? progress
      ? getClearCacheStepLabel(progress.step)
      : 'resyncing'
    : failure
      ? failure.message
      : !workerSyncHeight
        ? 'connecting'
        : syncing
          ? 'syncing'
          : 'up to date';

  return (
    <SettingsScreen title='zcash' category='networks' backPath={PopupPath.SETTINGS_NETWORKS_HOME}>
      <div className='flex flex-col gap-4'>
        <Section title='sync'>
          <div className='relative flex h-[58px] items-center gap-3 px-3.5'>
            <span
              className={cn(
                'size-2 shrink-0',
                failure ? 'bg-hanko' : status === 'up to date' ? 'bg-success' : 'bg-zigner-gold',
              )}
            />
            <span className='flex min-w-0 grow flex-col gap-[3px]'>
              <span className='truncate text-sm text-fg-high'>{status}</span>
              {workerSyncHeight > 0 && (
                <span className='text-[11px] text-fg-muted'>
                  block {workerSyncHeight.toLocaleString()}
                </span>
              )}
            </span>
            {pct != null && <span className='text-label text-fg-muted'>{pct}%</span>}
            {pct != null && (
              <span
                className='absolute bottom-0 left-0 h-0.5 bg-zigner-gold transition-[width]'
                style={{ width: `${pct}%` }}
              />
            )}
          </div>
          <Row
            type='value'
            label='starts from'
            value={
              birthday != null
                ? `block ${birthday.toLocaleString()} · ${formatBlockMonth(birthday)}`
                : 'auto'
            }
            onPress={() => navigate(PopupPath.SETTINGS_WALLETS)}
          />
          <Row
            type='value'
            label='node'
            value={endpoint ? endpoint.replace(/^\w+:\/\//, '').replace(/\/.*$/, '') : 'auto'}
            onPress={() => rawNavigate(`${PopupPath.SETTINGS_NETWORKS}?network=zcash`)}
          />
        </Section>

        <Section title='if something looks wrong'>
          <Row
            type='screen'
            label='sync again from the start'
            description='for a missing payment or a wrong balance'
            onPress={() => setConfirmOpen(true)}
            disabled={resyncing}
          />
        </Section>
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
            <Button
              variant='secondary'
              size='md'
              className='w-28'
              onClick={() => setConfirmOpen(false)}
            >
              not now
            </Button>
            <Button
              variant='primary'
              size='md'
              className='flex-1'
              onClick={() => void startResync()}
            >
              sync again
            </Button>
          </div>
        </div>
      </Sheet>
    </SettingsScreen>
  );
};
