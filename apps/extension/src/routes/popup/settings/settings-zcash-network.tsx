import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { formatBlockMonth, rescanStartHeight } from '../../../utils/zcash-blocks';
import { rescanZcash } from '../../../services/zcash-resync';
import {
  RescanDateInput,
  dateOfBlock,
  rescanHeightOf,
  rescanHeightOk,
} from '../../../components/zcash/sync-status';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { Row } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';

/** the wallet's stored birthday (an external system, read once per wallet) */
const useBirthday = (vaultId: string | undefined): number | null => {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    if (!vaultId) {
      return;
    }
    let live = true;
    const key = `zcashBirthday_${vaultId}`;
    void chrome.storage.local.get(key).then(r => {
      if (live) {
        setH(Number.isFinite(Number(r[key])) && r[key] != null ? Number(r[key]) : null);
      }
    });
    return () => {
      live = false;
    };
  }, [vaultId]);
  return h;
};

/**
 * zcash network screen (SetSync.dc.html). heights come from the zcash worker
 * and the zcash node the home screen already asks. this screen owns rescan:
 * from a date (starts from) or from the wallet's start; both run the same
 * rescan service as the home sync strip. the note database is shared, so
 * either one resyncs every wallet on this computer.
 */
export const SettingsZcashNetwork = () => {
  const rawNavigate = useNavigate();
  const vaultId = useStore(selectEffectiveKeyInfo)?.id;
  const endpoint = useStore(s => s.networks.networks.zcash.endpoint);
  const { workerSyncHeight, workerChainHeight, chainTip, failure } = useZcashSyncStatus();
  const birthday = useBirthday(vaultId);

  const [sheet, setSheet] = useState<'start' | 'date' | null>(null);
  const [date, setDate] = useState('');
  const [resyncing, setResyncing] = useState(false);
  const fromDate = rescanHeightOf(date);

  const rescan = async (h: number) => {
    setSheet(null);
    setResyncing(true);
    try {
      await rescanZcash(h);
    } catch (err) {
      console.error('[zcash] rescan failed:', err);
    } finally {
      setResyncing(false);
    }
  };

  const tip = chainTip?.height || workerChainHeight;
  const behind = tip && workerSyncHeight ? Math.max(0, tip - workerSyncHeight) : null;
  const syncing = resyncing || (behind != null && behind > 10);
  const pct =
    syncing && tip ? Math.min(100, Math.round((workerSyncHeight / tip) * 100)) : undefined;

  const status = resyncing
    ? 'reading the chain again'
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
            onPress={() => {
              setDate(dateOfBlock(birthday ?? 0));
              setSheet('date');
            }}
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
            onPress={() => setSheet('start')}
            disabled={resyncing}
          />
        </Section>
      </div>

      <Sheet
        open={sheet === 'start'}
        onOpenChange={o => setSheet(o ? 'start' : null)}
        title='sync zcash again?'
      >
        <p className='text-[13px]/[1.6] text-fg'>
          this resyncs zcash for every wallet on this computer, each read again from its own start.
          your keys and your zec are not touched.
        </p>
        <span className='text-label text-fg-muted'>you can keep using zafu</span>
        <div className='flex gap-2 pt-1'>
          <Button variant='secondary' className='w-[110px]' onClick={() => setSheet(null)}>
            not now
          </Button>
          <Button className='flex-1' onClick={() => void rescan(rescanStartHeight(birthday))}>
            sync again
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={sheet === 'date'}
        onOpenChange={o => setSheet(o ? 'date' : null)}
        title='sync again from a date'
      >
        <label className='flex h-12 items-center justify-between gap-3 border border-border-soft bg-elev-2 px-3.5 text-sm'>
          <span className='text-fg-muted'>starts from</span>
          <RescanDateInput value={date} onChange={setDate} />
        </label>
        {rescanHeightOk(fromDate) && (
          <p className='text-[13px]/[1.6] text-fg'>
            zafu forgets what it has found and reads again from block {fromDate.toLocaleString()}.
            anything received before that block is not found again.
          </p>
        )}
        <div className='flex gap-2 pt-1'>
          <Button variant='secondary' className='w-[110px]' onClick={() => setSheet(null)}>
            not now
          </Button>
          <Button
            variant='danger'
            className='flex-1'
            disabled={!rescanHeightOk(fromDate)}
            onClick={() => void rescan(fromDate)}
          >
            read again from {rescanHeightOk(fromDate) ? fromDate.toLocaleString() : 'a date'}
          </Button>
        </div>
      </Sheet>
    </SettingsScreen>
  );
};
