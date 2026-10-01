/**
 * Import wallet-birthday step - Onb8When board: six date presets and a
 * fixed-height sync estimate line are the main path. The free-form date
 * field this screen used to have also carried an "advanced: exact block
 * height" control that expanded in place, which the wave rules forbid - it
 * is back as a quiet link that opens a bottom sheet instead (nothing expands
 * in place; the screen underneath never moves), for the power users
 * restoring an old wallet who know their exact birthday block. Built from
 * plain markup rather than the shared Sheet primitive (which wraps
 * @radix-ui/react-dialog, not a direct dependency of this package) - see the
 * comment at its render site.
 *
 * Only imported wallets reach this screen - a freshly generated wallet has
 * no history, so it syncs from the chain tip and never asks.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../../state';
import { importSelector } from '../../../state/seed-phrase/import';
import { usePageNav } from '../../../utils/navigate';
import { navigateToPasswordPage } from './password/utils';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { PagePath } from '../paths';
import {
  dateToBlock,
  describeZcashHeight,
  safeBirthdayFloor,
  formatBlockMonth,
} from '../../../utils/zcash-blocks';
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
  const [customHeight, setCustomHeight] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [blockDraft, setBlockDraft] = useState('');

  const valid = phrase.length > 0 && phrase.every(w => w.length > 0) && phraseIsValid();
  useEffect(() => {
    if (!valid) {
      navigate(PagePath.IMPORT_SEED_PHRASE);
    }
  }, [valid, navigate]);
  useEffect(() => {
    sessionStorage.removeItem(PENDING_ZCASH_BIRTHDAY_KEY);
  }, []);
  useEffect(() => {
    if (!sheetOpen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheetOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

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

  const resolved =
    customHeight != null
      ? Math.max(ZCASH_ORCHARD_ACTIVATION, customHeight)
      : safeBirthdayFloor(presets[choice]!.height);
  const note =
    customHeight != null
      ? `sync starts at block ${resolved.toLocaleString()} (${formatBlockMonth(resolved)})`
      : presets[choice]!.label === 'not sure'
        ? `full sync from ${formatBlockMonth(ZCASH_ORCHARD_ACTIVATION)} · about 10 min`
        : `sync starts ${formatBlockMonth(resolved)} · under a few minutes`;

  const proceed = () => {
    sessionStorage.setItem(PENDING_ZCASH_BIRTHDAY_KEY, String(resolved));
    navigateToPasswordPage(navigate, SEED_PHRASE_ORIGIN.IMPORTED);
  };

  const draftNum = parseInt(blockDraft, 10);
  const draftHint = blockDraft.trim() ? describeZcashHeight(draftNum) : null;
  const applyCustom = () => {
    if (!isNaN(draftNum) && draftNum > 0) {
      setCustomHeight(draftNum);
      setSheetOpen(false);
    }
  };

  return (
    <OnboardingShell art='bamboo'>
      <FadeTransition>
        <div className='flex flex-col gap-[22px]'>
          <OnboardingBack onClick={() => navigate(-1)} />
          <h1 className='font-display text-[38px] leading-[1.2] text-fg-high'>
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
                onClick={() => {
                  setChoice(i);
                  setCustomHeight(null);
                }}
                className={cn(
                  'h-[52px] border text-body text-fg-high',
                  customHeight == null && i === choice
                    ? 'border-zigner-gold bg-zigner-gold/10'
                    : 'border-border-soft bg-elev-1',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className='flex h-12 items-center gap-2.5 border border-border-soft bg-elev-1 px-4'>
            <span
              className='i-ph-clock-counter-clockwise size-[15px] shrink-0 text-zigner-gold'
              aria-hidden='true'
            />
            <span className='text-body text-fg'>{note}</span>
          </div>

          <button
            type='button'
            onClick={() => {
              setBlockDraft(customHeight != null ? String(customHeight) : '');
              setSheetOpen(true);
            }}
            className='self-start bg-transparent text-label text-fg-muted transition-colors hover:text-fg-high lowercase'
          >
            {customHeight != null
              ? `exact block ${customHeight.toLocaleString()} · change`
              : 'set an exact block height'}
          </button>

          <Button variant='primary' className='h-14 w-full text-body' onClick={proceed}>
            continue
          </Button>
        </div>
      </FadeTransition>

      {/* A hand-built equivalent of the shared Sheet primitive, not <Sheet>
          itself: @radix-ui/react-dialog isn't a direct dependency of the
          extension package (only of packages/ui), so importing it here
          directly fails typecheck. Same shape and behavior otherwise: fixed
          to the bottom, square corners, 1px top border, a click-to-close
          scrim, Esc-to-close. Rendered through a portal to document.body,
          outside OnboardingShell's own tree, matching how Sheet itself
          portals - keeps a bottom sheet correct regardless of which flex
          layout opens it. */}
      {sheetOpen &&
        createPortal(
          <div className='fixed inset-0 z-50 flex flex-col justify-end'>
            <button
              type='button'
              aria-label='close'
              onClick={() => setSheetOpen(false)}
              className='absolute inset-0 border-0 bg-canvas/85'
            />
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='birthday-sheet-title'
              className='relative z-10 flex max-h-[85vh] flex-col gap-3 border-t border-border-hard bg-elev-1 p-4 pb-5'
            >
              <div className='flex items-center justify-between gap-3'>
                <span id='birthday-sheet-title' className='text-body text-fg-high'>
                  exact block height
                </span>
                <button
                  type='button'
                  aria-label='close'
                  onClick={() => setSheetOpen(false)}
                  className='grid size-7 shrink-0 place-items-center bg-transparent text-fg-dim transition-colors hover:text-fg-high'
                >
                  <span className='i-ph-x size-4' aria-hidden='true' />
                </button>
              </div>
              <p className='text-label text-fg-muted lowercase'>
                for restoring an old wallet when you know its birthday block exactly. sync starts
                there - a lower number only costs scan time, a higher one can hide older notes.
              </p>
              <div className='flex flex-col gap-2'>
                <label htmlFor='birthday-block' className='text-label text-fg-muted lowercase'>
                  block height
                </label>
                <input
                  id='birthday-block'
                  type='number'
                  min={ZCASH_ORCHARD_ACTIVATION}
                  step='1'
                  value={blockDraft}
                  onChange={e => setBlockDraft(e.target.value)}
                  placeholder={String(ZCASH_ORCHARD_ACTIVATION)}
                  className='h-11 w-full border border-border-soft bg-elev-2 px-3 font-mono text-body text-fg-high'
                />
                {draftHint && (
                  <span
                    className={cn('text-label', draftHint.ok ? 'text-fg-dim' : 'text-hanko-light')}
                  >
                    {draftHint.text}
                  </span>
                )}
              </div>
              <Button
                variant='primary'
                className='h-11 w-full text-body'
                disabled={!draftHint?.ok}
                onClick={applyCustom}
              >
                use this height
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </OnboardingShell>
  );
};
