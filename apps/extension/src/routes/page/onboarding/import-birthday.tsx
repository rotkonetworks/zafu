/**
 * When the wallet began - Onb8When board. Six presets set where syncing
 * starts; an exact block height rises in a sheet for people who know it.
 * Everything is estimated on this computer, nothing asks the network.
 */

import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { validateSeedPhrase } from '../../../state/seed-phrase/mnemonic';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { StartPresets } from '../../../components/wallet/start-presets';
import {
  dateToBlock,
  describeZcashHeight,
  safeBirthdayFloor,
  formatBlockMonth,
} from '../../../utils/zcash-blocks';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';
import { PENDING_ZCASH_BIRTHDAY_KEY } from './constants';
import { birthdayOriginOf, PASSWORD_PATH } from './flow';
import { useOnboarding } from '.';
import { SEED_PHRASE_ORIGIN } from './password/types';

const yearStart = (yearsAgo: number) =>
  new Date(Date.UTC(new Date().getUTCFullYear() - yearsAgo, 0, 1));

/** where syncing starts; shared with the ledger connect screen */
export const presets = () => {
  const year = new Date().getUTCFullYear();
  return [
    { label: 'this month', height: safeBirthdayFloor(dateToBlock(new Date())) },
    { label: 'this year', height: safeBirthdayFloor(dateToBlock(yearStart(0))) },
    { label: String(year - 1), height: safeBirthdayFloor(dateToBlock(yearStart(1))) },
    { label: String(year - 2), height: safeBirthdayFloor(dateToBlock(yearStart(2))) },
    { label: 'earlier', height: safeBirthdayFloor(dateToBlock(yearStart(4))) },
    { label: 'not sure', height: ZCASH_ORCHARD_ACTIVATION },
  ];
};

export const ImportBirthday = () => {
  const navigate = usePageNav();
  const origin = birthdayOriginOf(useLocation().pathname) ?? SEED_PHRASE_ORIGIN.IMPORTED;
  const phraseOk = useStore(s => validateSeedPhrase(s.seedPhrase.import.phrase));
  const { viewingKey } = useOnboarding();
  // each path's birthday follows the screen that holds its wallet; reached
  // without it (a reload, a typed url), go back there
  const source = {
    [SEED_PHRASE_ORIGIN.IMPORTED]: { ok: phraseOk, at: PagePath.IMPORT_SEED_PHRASE },
    [SEED_PHRASE_ORIGIN.VIEWING_KEY]: { ok: !!viewingKey, at: PagePath.IMPORT_VIEWING_KEY },
  }[origin];
  const [options] = useState(presets);
  // a preset index, or an exact height from the sheet
  const [pick, setPick] = useState<number | { exact: number }>(1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState('');

  if (!source.ok) {
    return <Navigate to={source.at} replace />;
  }

  const exact = typeof pick === 'object';
  const height = exact ? pick.exact : options[pick]!.height;
  const note = exact
    ? `sync starts at block ${height.toLocaleString()} · ${formatBlockMonth(height)}`
    : pick === options.length - 1
      ? `full sync from ${formatBlockMonth(height)}`
      : `sync starts ${formatBlockMonth(height)}`;

  const proceed = () => {
    sessionStorage.setItem(PENDING_ZCASH_BIRTHDAY_KEY, String(height));
    navigate(PASSWORD_PATH[origin]);
  };

  const draftNum = Number(draft);
  const draftHint = draft.trim() ? describeZcashHeight(draftNum) : null;
  const applyExact = (e: FormEvent) => {
    e.preventDefault();
    if (draftHint?.ok) {
      setPick({ exact: Math.floor(draftNum) });
      setSheetOpen(false);
    }
  };

  return (
    <div className='flex flex-col gap-[22px]'>
      <h1 className='font-display text-[38px] leading-[1.2] text-fg-high'>
        when did you start
        <br />
        using this wallet?
      </h1>
      <p className='text-body text-fg-muted'>roughly is fine. it only sets where syncing starts.</p>

      <StartPresets
        labels={options.map(p => p.label)}
        pick={typeof pick === 'number' ? pick : undefined}
        onPick={setPick}
      />

      <div className='flex h-12 items-center gap-2.5 border border-border-soft bg-elev-1 px-4'>
        <span className='i-zafu-enso size-[15px] shrink-0 text-zigner-gold' aria-hidden='true' />
        <span className='flex-1 text-data text-fg'>{note}</span>
        <button
          type='button'
          onClick={() => {
            setDraft(exact ? String(height) : '');
            setSheetOpen(true);
          }}
          className='bg-transparent text-label text-fg-muted transition-colors hover:text-fg-high'
        >
          {exact ? 'change' : 'exact block'}
        </button>
      </div>

      <span className='text-label text-fg-dim'>
        orchard and ironwood only · sapling funds won't show
      </span>

      <Button autoFocus className='h-14 w-full text-[15px]' onClick={proceed}>
        continue
      </Button>

      <Sheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title='exact block height'
        className='lg:inset-x-auto lg:left-[692px] lg:w-[460px] lg:border-x'
      >
        <form onSubmit={applyExact} className='flex flex-col gap-3'>
          <label htmlFor='birthday-block' className='text-label text-fg-muted'>
            block height
          </label>
          <Input
            id='birthday-block'
            inputMode='numeric'
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value.replace(/[^\d]/g, ''))}
            placeholder={String(ZCASH_ORCHARD_ACTIVATION)}
            className='text-body'
          />
          <span
            className={cn(
              'h-[18px] text-label',
              draftHint?.ok === false ? 'text-warning' : 'text-fg-dim',
            )}
          >
            {draftHint?.text ?? ''}
          </span>
          <Button type='submit' disabled={!draftHint?.ok} className='w-full'>
            use this height
          </Button>
        </form>
      </Sheet>
    </div>
  );
};
