/**
 * Import wallet-birthday step.
 *
 * Only imported wallets reach this screen - a freshly generated wallet has no
 * history, so it syncs from the chain tip and never asks. An imported wallet
 * is the opposite: if we start scanning too late we silently miss every note
 * minted before the start height, so this step's whole job is to land a start
 * height at or before the real birthday.
 *
 * Two honest exits, and no third:
 *   - pick a date (primary). safeBirthdayFloor rounds it down + adds margin.
 *   - "I don't remember" (fallback). Confirms, then scans from Orchard
 *     activation (~may 2022) - safe but slow.
 *
 * There is deliberately no "sync from tip" option here. For an imported
 * wallet that is the "forget every note you hold" footgun documented on
 * rescanStartHeight; only a fresh wallet is allowed to start at the tip.
 */

import { useEffect, useState } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { usePageNav } from '../../../utils/navigate';
import { navigateToPasswordPage } from './password/utils';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { PagePath } from '../paths';
import { ZcashBirthdayField } from '../../../shared/components/zcash-birthday-field';
import { safeBirthdayFloor, formatBlockMonth } from '../../../utils/zcash-blocks';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';
import { PENDING_ZCASH_BIRTHDAY_KEY } from './constants';

export const ImportBirthday = () => {
  const navigate = usePageNav();
  const { phrase, phraseIsValid } = useStore(importSelector);
  const [height, setHeight] = useState<number | null>(null);
  const [confirmingUnknown, setConfirmingUnknown] = useState(false);

  // Guard direct-URL entry: without a valid phrase in the store there is
  // nothing to import, so send the user back to the start of the import flow.
  const valid = phrase.length > 0 && phrase.every(w => w.length > 0) && phraseIsValid();
  useEffect(() => {
    if (!valid) {
      navigate(PagePath.IMPORT_SEED_PHRASE);
    }
  }, [valid, navigate]);

  // Clear any birthday stashed by a previous pass so a stale value can never
  // leak into a different wallet (import -> back -> create).
  useEffect(() => {
    sessionStorage.removeItem(PENDING_ZCASH_BIRTHDAY_KEY);
  }, []);

  if (!valid) {
    return null;
  }

  const proceed = (rawHeight: number) => {
    sessionStorage.setItem(PENDING_ZCASH_BIRTHDAY_KEY, String(safeBirthdayFloor(rawHeight)));
    navigateToPasswordPage(navigate, SEED_PHRASE_ORIGIN.IMPORTED);
  };

  const canContinue = height != null && height >= ZCASH_ORCHARD_ACTIVATION;
  const orchardMonth = formatBlockMonth(ZCASH_ORCHARD_ACTIVATION);
  const resolvedMonth =
    canContinue && height != null ? formatBlockMonth(safeBirthdayFloor(height)) : null;

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <button
            type='button'
            onClick={() => navigate(-1)}
            className='mb-2 inline-flex items-center gap-1.5 self-start text-body text-fg-muted transition-colors hover:text-fg-high lowercase'
          >
            <span className='i-ph-arrow-left h-3 w-3' />
            back
          </button>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            around when did you create this wallet?
          </h2>
          <p className='text-xs text-fg-muted lowercase leading-snug'>
            an estimate is enough - this only sets how far back sync scans (how fast the first sync
            is), not whether your funds are safe. if unsure, pick an earlier date: too early only
            costs scan time, too late can hide older notes until a rescan.
          </p>
        </header>

        {!confirmingUnknown ? (
          <div className='flex flex-col gap-4'>
            <ZcashBirthdayField value={height} onChange={setHeight} />

            {resolvedMonth && (
              <p className='text-label text-fg-muted lowercase'>
                sync will start from ~{resolvedMonth} (rounded down for a small safety margin).
              </p>
            )}

            <div className='mt-2 flex flex-col gap-3'>
              <button
                type='button'
                disabled={!canContinue}
                onClick={() => canContinue && height != null && proceed(height)}
                className={cn(
                  'group inline-flex items-center justify-center gap-2 px-5 py-3 text-sm lowercase',
                  '[border-radius:14px] border transition-[transform,opacity,background-color,border-color] duration-200',
                  canContinue
                    ? 'border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold hover:-translate-y-[1px] hover:bg-zigner-gold/15'
                    : 'cursor-not-allowed border-border-soft/60 bg-elev-2/30 text-fg-muted',
                )}
              >
                continue
                {canContinue && (
                  <span className='i-ph-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
                )}
              </button>

              <button
                type='button'
                onClick={() => setConfirmingUnknown(true)}
                className='self-center text-label text-fg-muted hover:text-fg-high transition-colors lowercase'
              >
                i don't remember
              </button>
            </div>
          </div>
        ) : (
          <div className='flex flex-col gap-4'>
            <div className='flex flex-col gap-2 rounded-lg border border-border-soft p-3.5'>
              <span className='inline-flex items-center gap-2 text-sm text-fg-high lowercase'>
                <span className='i-ph-warning h-4 w-4 text-rust shrink-0' />
                scan from the earliest shielded height?
              </span>
              <p className='text-xs text-fg-muted lowercase leading-snug'>
                without a birthday, zafu scans from ~{orchardMonth} (orchard activation). this is
                safe and finds every note - but the first sync can take a long time. even a rough
                year is much faster.
              </p>
            </div>

            <div className='flex flex-col gap-3'>
              <button
                type='button'
                onClick={() => proceed(ZCASH_ORCHARD_ACTIVATION)}
                className='group inline-flex items-center justify-center gap-2 px-5 py-3 text-sm lowercase [border-radius:14px] border border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold transition-[transform,background-color] duration-200 hover:-translate-y-[1px] hover:bg-zigner-gold/15'
              >
                scan from ~{orchardMonth}
                <span className='i-ph-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
              </button>
              <button
                type='button'
                onClick={() => setConfirmingUnknown(false)}
                className='self-center text-label text-fg-muted hover:text-fg-high transition-colors lowercase'
              >
                go back and pick a date
              </button>
            </div>
          </div>
        )}
      </div>
    </FadeTransition>
  );
};
