/**
 * make it yours - the one optional step between a sealed wallet and "wallet
 * ready", on every path (create, import, watch-only, signer import). Every
 * row here writes straight through to the same storage the settings screens
 * read, so skipping it (or tapping "keep defaults" before touching anything)
 * changes nothing. Once something IS touched, "keep defaults" puts back the
 * snapshot taken on arrival (so it's a real "never mind", not a second
 * "save"); "save" just moves on with whatever is live.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { privacySelector, type ExplorerLinks } from '../../../state/privacy';
import { usePageNav } from '../../../utils/navigate';
import { hostOf } from '../../../net/destination';
import { PagePath } from '../paths';
import {
  useZafuTheme,
  useZafuFont,
  useApprovalSurface,
  FontRow,
  ApprovalsRow,
} from '../../popup/settings/settings-appearance';
import { ContactDiscoverySection, ExplorerLinksRow } from '../../popup/settings/settings-privacy';
import { ZcashNodeSheet } from '../../popup/settings/settings-zcash-network';
import { useAutoLock, AUTO_LOCK_OPTIONS } from '../../popup/settings/use-auto-lock';

// the three choices worth a tap before there is anything to lock; "off" and
// the finer options stay in settings > security, same list, same storage
const AUTO_LOCK_CHOICES = AUTO_LOCK_OPTIONS.filter(o => [5, 15, 60].includes(o.value)).map(o => ({
  label: o.label,
  value: String(o.value),
}));

interface Snapshot {
  theme: ReturnType<typeof useZafuTheme>['theme'];
  font: ReturnType<typeof useZafuFont>['font'];
  surface: ReturnType<typeof useApprovalSurface>['surface'];
  enableTransactionHistory: boolean;
  historyAsked: boolean;
  hideBalances: boolean;
  minutes: number;
  zcashEndpoint: string | undefined;
  explorerLinks: ExplorerLinks;
  openZcashLinks: boolean;
  openZafuLinks: boolean;
  keepPenumbraSyncing: boolean;
}

export const Personalize = () => {
  const navigate = usePageNav();
  const { state } = useLocation();
  const [touched, setTouched] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);

  const themeState = useZafuTheme();
  const fontState = useZafuFont();
  const surfaceState = useApprovalSurface();
  const { theme, set: setTheme } = themeState;
  const { settings, setSetting } = useStore(privacySelector);
  const { minutes, set: setAutoLock } = useAutoLock();
  const zcashEndpoint = useStore(s => s.networks.networks.zcash.endpoint);
  const setNetworkEndpoint = useStore(s => s.networks.setNetworkEndpoint);

  // one snapshot, taken once every value here has loaded for real (not the
  // pre-read placeholder) - this is what "keep defaults" restores to.
  const snapshot = useRef<Snapshot | null>(null);
  useEffect(() => {
    if (snapshot.current || !themeState.loaded || !fontState.loaded || !surfaceState.loaded) {
      return;
    }
    snapshot.current = {
      theme: themeState.theme,
      font: fontState.font,
      surface: surfaceState.surface,
      enableTransactionHistory: settings.enableTransactionHistory,
      historyAsked: settings.historyAsked,
      hideBalances: settings.hideBalances,
      minutes,
      zcashEndpoint,
      explorerLinks: settings.explorerLinks,
      openZcashLinks: settings.openZcashLinks,
      openZafuLinks: settings.openZafuLinks,
      keepPenumbraSyncing: settings.keepPenumbraSyncing,
    };
  });

  // the zcash-node sheet lives outside the "more settings" div's click-to-touch
  // wrapper (it's a sibling sheet), so a pick there needs its own touch: once
  // the snapshot exists, any value that drifts from it means something changed.
  useEffect(() => {
    const s = snapshot.current;
    if (s && s.zcashEndpoint !== zcashEndpoint) {
      setTouched(true);
    }
  }, [zcashEndpoint]);

  const keepDefaults = () => {
    const s = snapshot.current;
    if (touched && s) {
      themeState.restore(s.theme);
      fontState.restore(s.font);
      surfaceState.restore(s.surface);
      void setSetting('enableTransactionHistory', s.enableTransactionHistory);
      void setSetting('historyAsked', s.historyAsked);
      void setSetting('hideBalances', s.hideBalances);
      setAutoLock(s.minutes);
      void setNetworkEndpoint('zcash', s.zcashEndpoint ?? '');
      void setSetting('explorerLinks', s.explorerLinks);
      void setSetting('openZcashLinks', s.openZcashLinks);
      void setSetting('openZafuLinks', s.openZafuLinks);
      void setSetting('keepPenumbraSyncing', s.keepPenumbraSyncing);
    }
    navigate(PagePath.ONBOARDING_SUCCESS, { state, replace: true });
  };
  const save = () => navigate(PagePath.ONBOARDING_SUCCESS, { state, replace: true });

  const answerHistory = (keep: boolean) => {
    setTouched(true);
    void setSetting('historyAsked', true);
    void setSetting('enableTransactionHistory', keep);
  };

  return (
    <div className='flex flex-col gap-[22px]'>
      <h1 className='font-display text-[38px] text-fg-high'>make it yours</h1>

      <div className='grid grid-cols-2 gap-2.5'>
        {(['sumi', 'washi'] as const).map(t => (
          <button
            key={t}
            type='button'
            aria-pressed={theme === t}
            onClick={() => {
              setTouched(true);
              setTheme(t);
            }}
            className={cn(
              'h-14 border text-body lowercase transition-colors',
              theme === t
                ? 'border-zigner-gold bg-zigner-gold/10 text-fg-high'
                : 'border-border-soft bg-elev-1 text-fg-muted hover:bg-elev-2',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <RowGroup>
        <div className='flex items-center justify-between gap-3 px-3.5 py-2.5'>
          <span className='text-sm text-fg-high lowercase'>history</span>
          <Segmented
            label='history'
            value={settings.enableTransactionHistory ? 'keep' : 'balance'}
            onChange={v => answerHistory(v === 'keep')}
            options={[
              { value: 'keep', label: 'keep history' },
              { value: 'balance', label: 'show only balance' },
            ]}
            className='w-[260px]'
          />
        </div>
        <Row
          type='toggle'
          label='hide balances'
          checked={settings.hideBalances}
          onChange={v => {
            setTouched(true);
            void setSetting('hideBalances', v);
          }}
        />
        <div className='flex items-center justify-between gap-3 px-3.5 py-2.5'>
          <span className='text-sm text-fg-high lowercase'>auto-lock</span>
          <Segmented
            label='auto-lock'
            value={String(minutes)}
            onChange={v => {
              setTouched(true);
              setAutoLock(Number(v));
            }}
            options={AUTO_LOCK_CHOICES}
            className='w-[180px]'
          />
        </div>
        <Row type='screen' label='more settings' onPress={() => setMoreOpen(true)} />
      </RowGroup>

      <span className='text-label text-fg-dim'>you can change any of this in settings</span>

      <div className='flex flex-col gap-2'>
        <Button autoFocus className='h-14 w-full text-[15px]' onClick={keepDefaults}>
          keep defaults
        </Button>
        {/* reserved so tapping anything above never shifts the page (nothing expands in place) */}
        <div className='h-14'>
          {touched && (
            <Button variant='secondary' className='h-14 w-full text-[15px]' onClick={save}>
              save
            </Button>
          )}
        </div>
      </div>

      <Sheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title='more settings'
        className='lg:inset-x-auto lg:left-[692px] lg:w-[460px] lg:border-x'
      >
        <div
          onClick={() => setTouched(true)}
          className='-mx-4 flex min-h-0 flex-col gap-4 overflow-y-auto px-4'
        >
          <RowGroup>
            <FontRow state={fontState} />
            <ApprovalsRow state={surfaceState} />
          </RowGroup>
          <RowGroup>
            <Row
              type='value'
              label='zcash node'
              value={(zcashEndpoint && hostOf(zcashEndpoint)) || 'auto'}
              onPress={() => setNodeOpen(true)}
            />
            <ExplorerLinksRow />
            <Row
              type='toggle'
              label='zcash: links'
              checked={settings.openZcashLinks}
              onChange={v => void setSetting('openZcashLinks', v)}
            />
            <Row
              type='toggle'
              label='zafu: links'
              checked={settings.openZafuLinks}
              onChange={v => void setSetting('openZafuLinks', v)}
            />
          </RowGroup>
          {settings.enableIdentity && <ContactDiscoverySection />}
        </div>
      </Sheet>

      <ZcashNodeSheet
        open={nodeOpen}
        onOpenChange={setNodeOpen}
        className='lg:inset-x-auto lg:left-[692px] lg:w-[460px] lg:border-x'
      />
    </div>
  );
};
