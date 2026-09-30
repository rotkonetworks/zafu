/**
 * Import wallet-birthday step - Onb8When board: six date presets and a
 * fixed-height sync estimate line, not the free-form date field with an
 * "advanced" block-height entry that used to live here (that control
 * expanded in place, which the wave rules forbid; dropped - the presets
 * cover the normal case and a wrong choice only costs sync time, never
 * safety, since it always rounds down. reported as a scope cut).
 *
 * Only imported wallets reach this screen - a freshly generated wallet has
 * no history, so it syncs from the chain tip and never asks.
 */

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { usePageNav } from '../../../utils/navigate';
import { navigateToPasswordPage } from './password/utils';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { PagePath } from '../paths';
import { dateToBlock, safeBirthdayFloor, formatBlockMonth } from '../../../utils/zcash-blocks';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';
import { PENDING_ZCASH_BIRTHDAY_KEY } from './constants';
import { OnboardingBack, OnboardingShell } from './onboarding-shell';

const startOfYear = (yearsAgo: number) => {
  const d = new Date();
  d.setUTCMonth(0, 1);
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  return d;
};

export const ImportBirthday = () => {
  const navigate = usePageNav();
  const { phrase, phraseIsValid } = useStore(importSelector);
  const [choice, setChoice] = useState(2); // default: "this year"

  const valid = phrase.length > 0 && phrase.every(w => w.length > 0) && phraseIsValid();
  useEffect(() => {
    if (!valid) {
      navigate(PagePath.IMPORT_SEED_PHRASE);
    }
  }, [valid, navigate]);
  useEffect(() => {
    sessionStorage.removeItem(PENDING_ZCASH_BIRTHDAY_KEY);
  }, []);

  const presets = useMemo(() => {
    const now = new Date();
    return [
      { label: 'this month', height: dateToBlock(now) },
      { label: 'this year', height: dateToBlock(startOfYear(0)) },
      { label: String(now.getUTCFullYear() - 1), height: dateToBlock(startOfYear(1)) },
      { label: String(now.getUTCFullYear() - 2), height: dateToBlock(startOfYear(2)) },
      { label: 'earlier', height: dateToBlock(startOfYear(4)) },
      { label: 'not sure', height: ZCASH_ORCHARD_ACTIVATION },
    ];
  }, []);

  if (!valid) {
    return null;
  }

  const resolved = safeBirthdayFloor(presets[choice]!.height);
  const note =
    presets[choice]!.label === 'not sure'
      ? `full sync from ${formatBlockMonth(ZCASH_ORCHARD_ACTIVATION)} · about 10 min`
      : `sync starts ${formatBlockMonth(resolved)} · under a few minutes`;

  const proceed = () => {
    sessionStorage.setItem(PENDING_ZCASH_BIRTHDAY_KEY, String(resolved));
    navigateToPasswordPage(navigate, SEED_PHRASE_ORIGIN.IMPORTED);
  };

  return (
    <OnboardingShell art='bamboo'>
      <FadeTransition>
        <div className='flex flex-col gap-[22px]'>
          <OnboardingBack onClick={() => navigate(-1)} />
          <h1 className='font-display text-[38px] font-medium leading-[1.2] text-fg-high'>
            when did you start
            <br />
            using this wallet?
          </h1>
          <p className='text-body text-fg-muted lowercase'>
            roughly is fine. it only sets where syncing starts.
          </p>

          <div className='grid grid-cols-3 gap-2.5'>
            {presets.map((p, i) => (
              <button
                key={p.label}
                type='button'
                onClick={() => setChoice(i)}
                className={cn(
                  'h-[52px] border text-body text-fg-high',
                  i === choice ? 'border-zigner-gold bg-zigner-gold/10' : 'border-surface-border-soft bg-surface-elev-1',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className='flex h-12 items-center gap-2.5 border border-surface-border-soft bg-surface-elev-1 px-4'>
            <span className='i-ph-clock-counter-clockwise size-[15px] shrink-0 text-zigner-gold' aria-hidden='true' />
            <span className='text-body text-fg'>{note}</span>
          </div>

          <Button variant='primary' className='h-14 w-full text-body' onClick={proceed}>
            continue
          </Button>
        </div>
      </FadeTransition>
    </OnboardingShell>
  );
};
