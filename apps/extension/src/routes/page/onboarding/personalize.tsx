/**
 * make it yours - the one optional step between a sealed wallet and "wallet
 * ready", on every path (create, import, watch-only, signer import). Every
 * row here writes straight through to the same storage the settings screens
 * read, so skipping it changes nothing and answering it needs no separate
 * save: "keep defaults" and "save" both just move on.
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import { usePageNav } from '../../../utils/navigate';
import { hostOf } from '../../../net/destination';
import { PagePath } from '../paths';
import { useZafuTheme, FontRow, ApprovalsRow } from '../../popup/settings/settings-appearance';
import { ContactDiscoverySection } from '../../popup/settings/settings-privacy';
import { ZcashNodeSheet } from '../../popup/settings/settings-zcash-network';
import { useAutoLock } from '../../popup/settings/use-auto-lock';

const AUTO_LOCK_CHOICES = [
  { label: '5 min', value: '5' },
  { label: '15 min', value: '15' },
  { label: '60 min', value: '60' },
] as const;

export const Personalize = () => {
  const navigate = usePageNav();
  const { state } = useLocation();
  const [touched, setTouched] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);

  const { theme, set: setTheme } = useZafuTheme();
  const { settings, setSetting } = useStore(privacySelector);
  const { minutes, set: setAutoLock } = useAutoLock();
  const zcashEndpoint = useStore(s => s.networks.networks.zcash.endpoint);

  const proceed = () => navigate(PagePath.ONBOARDING_SUCCESS, { state, replace: true });

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
            className='w-[230px]'
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
        <Button autoFocus className='h-14 w-full text-[15px]' onClick={proceed}>
          keep defaults
        </Button>
        {touched && (
          <Button variant='secondary' className='h-14 w-full text-[15px]' onClick={proceed}>
            save
          </Button>
        )}
      </div>

      <Sheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title='more settings'
        className='lg:inset-x-auto lg:left-[692px] lg:w-[460px] lg:border-x'
      >
        <div
          onClick={() => setTouched(true)}
          className='-mx-4 flex flex-col gap-4 overflow-y-auto px-4'
        >
          <RowGroup>
            <FontRow />
            <ApprovalsRow />
          </RowGroup>
          <RowGroup>
            <Row
              type='value'
              label='zcash node'
              value={(zcashEndpoint && hostOf(zcashEndpoint)) || 'auto'}
              onPress={() => setNodeOpen(true)}
            />
            <Row
              type='toggle'
              label='explorer links'
              checked={settings.enableExplorerLinks}
              onChange={v => void setSetting('enableExplorerLinks', v)}
            />
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
            <Row
              type='toggle'
              label='background sync'
              checked={settings.enableBackgroundSync}
              onChange={v => void setSetting('enableBackgroundSync', v)}
            />
          </RowGroup>
          {settings.enableIdentity && <ContactDiscoverySection />}
        </div>
      </Sheet>

      <ZcashNodeSheet open={nodeOpen} onOpenChange={setNodeOpen} />
    </div>
  );
};
