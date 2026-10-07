import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { useZcashChainCheck, useZcashWorkerSync } from '../../../hooks/zcash-sync';
import { selectEffectiveKeyInfo, selectEnabledNetworks } from '../../../state/keyring';
import { formatBlockMonth, rescanStartHeight } from '../../../utils/zcash-blocks';
import { rescanZcash } from '../../../services/zcash-resync';
import {
  RescanDateInput,
  dateOfBlock,
  rescanHeightOf,
  rescanHeightOk,
} from '../../../components/zcash/sync-status';
import { ZCASH_MAINNET_ENDPOINTS, findPresetByUrl } from '../../../config/zcash-endpoints';
import { measurePresetLatencies } from '../../../state/keyring/endpoint-latency';
import { hostOf } from '../../../net/destination';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { NodeSheet } from './node-sheet';
import { Row } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { useExplain, type ExplainId } from './settings-explain';
import { OptionsRow } from './sheet-options';
import { selectZcashBackend } from '../../../state/networks';
import { ZCASH_BACKENDS } from '../../../state/keyring/zcash-backend';
import type { ExplorerLinks } from '../../../state/privacy';
import { BUNDLED_SERVICE_CONFIG } from '../../../services/voting/bundled-config';
import { usePopupNav } from '../../../utils/navigate';

type Explain = (id: ExplainId) => { onExplain?: (label: string) => void };
import { Clipped } from '@repo/ui/components/ui/clipped';

/** the wallet's stored birthday (an external system, read once per wallet) */
const useBirthday = (vaultId: string | undefined) => {
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
  return [h, setH] as const;
};

const speedTest = async () =>
  new Map([...(await measurePresetLatencies())].map(([url, l]) => [url, l.rttMs]));

/** the zcash node sheet: the user picks a node, never its kind - the node says what it is */
export const ZcashNodeSheet = ({
  open,
  onOpenChange,
  className,
  onExplain,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  className?: string;
  onExplain?: (label: string) => void;
}) => {
  const endpoint = useStore(s => s.networks.networks.zcash.endpoint) ?? '';
  const setEndpoint = useStore(s => s.networks.setNetworkEndpoint);
  const presets = ZCASH_MAINNET_ENDPOINTS;
  return (
    <NodeSheet
      open={open}
      onOpenChange={onOpenChange}
      className={className}
      title='zcash node'
      presets={presets}
      current={endpoint}
      egress='zcash-servers'
      measure={speedTest}
      onPick={url => setEndpoint('zcash', url)}
      onExplain={onExplain}
    />
  );
};

/** memo decoys and the mempool watch are zidecar's own; a lightwalletd has neither */
const ZcashWireRows = ({ explainProps }: { explainProps: Explain }) => {
  const memo = useStore(s => s.networks.networks.zcash.memoSyncStrategy ?? 'private');
  const mempool = useStore(s => s.networks.networks.zcash.mempoolWatch ?? 'off');
  const zidecar = useStore(s => !!ZCASH_BACKENDS[selectZcashBackend(s)].extras);
  const setMemo = useStore(s => s.networks.setMemoSyncStrategy);
  const setMempool = useStore(s => s.networks.setMempoolWatch);
  const needs = zidecar ? undefined : 'needs a zidecar node';
  return (
    <>
      <Row
        type='toggle'
        label='memo decoys'
        description={
          needs ??
          (memo === 'private'
            ? 'the node sees 3x the buckets, not which are yours'
            : 'the node sees only your buckets')
        }
        disabled={!zidecar}
        checked={memo === 'private'}
        onChange={v => void setMemo('zcash', v ? 'private' : 'fast')}
        {...explainProps('privacy.zcashMemoDecoys')}
      />
      <Row
        type='toggle'
        label="see payments before they're mined"
        description={needs ?? 'the node sees a check every 10 s'}
        disabled={!zidecar}
        checked={mempool === 'on'}
        onChange={v => void setMempool('zcash', v ? 'on' : 'off')}
        {...explainProps('privacy.zcashInstantPending')}
      />
    </>
  );
};

const EXPLORER_OPTIONS: readonly { value: ExplorerLinks; label: string; desc: string }[] = [
  { value: 'off', label: 'off', desc: 'nothing leaves zafu' },
  { value: 'copy', label: 'copy', desc: 'you choose where to paste it' },
  { value: 'open', label: 'open', desc: 'the explorer sees your ip and the transaction' },
];

/** what a transaction shows of its block explorer page: nothing, a link to copy, or one to open */
export const ExplorerLinksRow = ({ onExplain }: { onExplain?: (label: string) => void }) => {
  const value = useStore(s => s.privacy.settings.explorerLinks);
  const setSetting = useStore(s => s.privacy.setSetting);
  return (
    <OptionsRow
      label='explorer links'
      description='the explorer sees your ip and the txid you open'
      value={value}
      options={EXPLORER_OPTIONS}
      onPick={v => void setSetting('explorerLinks', v)}
      onExplain={onExplain}
    />
  );
};

/** the zcash switches that are plain booleans, as data */
const TOGGLES: readonly {
  key: 'zcashTransparentEachBlock' | 'enableTransactionHistory' | 'openZcashLinks';
  label: string;
  description: string;
  explainId: ExplainId;
}[] = [
  {
    key: 'zcashTransparentEachBlock',
    label: 'check transparent each block',
    description: 'the node sees these addresses checked together',
    explainId: 'privacy.zcashTransparentEachBlock',
  },
  {
    key: 'enableTransactionHistory',
    label: 'keep history on this computer',
    description: 'stays here · nobody else sees it',
    explainId: 'privacy.txHistory',
  },
  {
    key: 'openZcashLinks',
    label: 'open zcash: payment links',
    description: 'a page can fill a send · you review it',
    explainId: 'privacy.zcashLinks',
  },
];

const ToggleRow = ({ t, explainProps }: { t: (typeof TOGGLES)[number]; explainProps: Explain }) => {
  const checked = useStore(s => s.privacy.settings[t.key]);
  const setSetting = useStore(s => s.privacy.setSetting);
  return (
    <Row
      type='toggle'
      label={t.label}
      description={t.description}
      checked={checked}
      onChange={v => void setSetting(t.key, v)}
      {...explainProps(t.explainId)}
    />
  );
};

const toggle = (key: (typeof TOGGLES)[number]['key'], explainProps: Explain) => (
  <ToggleRow t={TOGGLES.find(t => t.key === key)!} explainProps={explainProps} />
);

/** zcash: what your zcash node learns (SetZcash.dc.html). off, it says where to turn it on. */
export const SettingsZcashNetwork = () => {
  const on = useStore(s => selectEnabledNetworks(s).includes('zcash'));
  return on ? <ZcashOn /> : <ZcashOff />;
};

/** history is every network's, so it stays reachable while zcash is off */
const ZcashOff = () => {
  const navigate = usePopupNav();
  const { explainProps, sheet } = useExplain();
  return (
    <SettingsScreen title='zcash' category='zcash' home backPath={PopupPath.SETTINGS}>
      <Section>
        <Row
          type='value'
          label='zcash is off'
          description='a network that is off is never contacted'
          value='turn on'
          preload={PopupPath.SETTINGS_DEVICES}
          onPress={() => navigate(PopupPath.SETTINGS_DEVICES)}
        />
        {toggle('enableTransactionHistory', explainProps)}
      </Section>
      {sheet}
    </SettingsScreen>
  );
};

/**
 * heights come from the zcash worker. this screen owns rescan: from a date
 * (starts from) or from the wallet's start; both run the same rescan service
 * as the home sync strip. the note database is shared, so either one resyncs
 * every wallet on this computer.
 */
const ZcashOn = () => {
  const navigate = usePopupNav();
  const vaultId = useStore(selectEffectiveKeyInfo)?.id;
  const endpoint = useStore(s => s.networks.networks.zcash.endpoint);
  const preset = endpoint ? findPresetByUrl(endpoint) : undefined;
  // local progress only: opening this screen asks no node
  const { workerSyncHeight, workerChainHeight: tip, workerFailure: failure } = useZcashWorkerSync();
  const [birthday, setBirthday] = useBirthday(vaultId);
  const chain = useZcashChainCheck();
  const paused = chain?.status === 'failed';

  const [params] = useSearchParams();
  const [sheet, setSheet] = useState<'start' | 'date' | 'node' | null>(() =>
    params.get('sheet') === 'node' ? 'node' : null,
  );
  const [date, setDate] = useState('');
  const [resyncing, setResyncing] = useState(false);
  const fromDate = rescanHeightOf(date);
  const { explainProps, sheet: explainSheet } = useExplain();

  const rescan = async (h: number) => {
    setSheet(null);
    setResyncing(true);
    try {
      const height = await rescanZcash(h);
      if (height !== undefined) {
        setBirthday(height);
      }
    } catch (err) {
      console.error('[zcash] rescan failed:', err);
    } finally {
      setResyncing(false);
    }
  };

  const behind = tip && workerSyncHeight ? Math.max(0, tip - workerSyncHeight) : null;
  const syncing = resyncing || (behind != null && behind > 10);
  const pct =
    syncing && tip ? Math.min(100, Math.round((workerSyncHeight / tip) * 100)) : undefined;

  const status = resyncing
    ? 'reading the chain again'
    : paused
      ? "this server's chain didn't check out"
      : failure
        ? failure.message
        : !workerSyncHeight
          ? 'connecting'
          : syncing
            ? 'syncing'
            : 'up to date';

  return (
    <SettingsScreen title='zcash' category='zcash' home backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <Section title='node'>
          <div className='relative flex h-[58px] items-center gap-3 px-3.5'>
            <span
              className={cn(
                'size-2 shrink-0',
                failure || paused
                  ? 'bg-hanko'
                  : status === 'up to date'
                    ? 'bg-success'
                    : 'bg-zigner-gold',
              )}
            />
            <span className='flex min-w-0 grow flex-col gap-[3px]'>
              <Clipped className='text-sm text-fg-high'>{status}</Clipped>
              <Clipped className='text-[11px] text-fg-muted'>
                {[
                  workerSyncHeight > 0 && `block ${workerSyncHeight.toLocaleString()}`,
                  chain?.status === 'checked'
                    ? 'chain checked'
                    : chain?.reason === 'clock'
                      ? "this computer's clock looks off"
                      : 'chain not verified',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Clipped>
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
            label='node'
            description={
              !preset && endpoint
                ? 'your own node · it sees your ip and what you sync'
                : 'it sees your ip and what you sync'
            }
            value={preset?.label ?? ((endpoint && hostOf(endpoint)) || 'auto')}
            onPress={() => setSheet('node')}
            {...explainProps('network.zcashNode')}
          />
          <Row
            type='value'
            label='starts from'
            description='the node sees where your sync starts'
            value={birthday != null ? formatBlockMonth(birthday) : 'auto'}
            onPress={() => {
              setDate(dateOfBlock(birthday ?? 0));
              setSheet('date');
            }}
            disabled={resyncing}
            {...explainProps('network.zcashStartsFrom')}
          />
          <Row
            type='screen'
            label='sync again from the start'
            description='for a missing payment or a wrong balance'
            onPress={() => setSheet('start')}
            disabled={resyncing}
          />
        </Section>

        <Section title='what the node learns'>
          <ZcashWireRows explainProps={explainProps} />
          {toggle('zcashTransparentEachBlock', explainProps)}
        </Section>

        <Section title='history and links'>
          {toggle('enableTransactionHistory', explainProps)}
          <ExplorerLinksRow {...explainProps('privacy.explorerLinks')} />
          {toggle('openZcashLinks', explainProps)}
          <Row
            type='value'
            label='voting servers'
            description='they see your ip when you vote'
            value={String(BUNDLED_SERVICE_CONFIG.vote_servers.length)}
            preload={PopupPath.SETTINGS_VOTING}
            onPress={() => navigate(PopupPath.SETTINGS_VOTING)}
          />
        </Section>
      </div>

      <ZcashNodeSheet
        open={sheet === 'node'}
        onOpenChange={o => setSheet(o ? 'node' : null)}
        onExplain={explainProps('network.ownNode').onExplain}
      />

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
      {explainSheet}
    </SettingsScreen>
  );
};
