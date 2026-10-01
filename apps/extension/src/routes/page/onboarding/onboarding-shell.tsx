/**
 * OnboardingShell - the full-tab first impression. Left art panel, right
 * column with back + step bars, one primary action per step, calm copy.
 * See the design canvas Onb1..Onb8 boards.
 *
 * Deviations from the boards, reported in the rework/onboarding PR:
 *  - the art panel's right-edge fade is a gradient in the board; the wave
 *    rules forbid gradients, so it is a plain 1px border here instead.
 *  - art is chosen per screen, not per theme (the boards do the same - the
 *    samurai/enso/castle/bamboo images are unchanged between sumi and washi).
 */

import { cn } from '@repo/ui/lib/utils';
import { Mark } from '@repo/ui/components/ui/mark';
import { useLocation } from 'react-router-dom';
import { PagePath } from '../paths';
import { getSeedPhraseOrigin } from './password/utils';
import { SEED_PHRASE_ORIGIN } from './password/types';

export type OnboardingArt = 'samurai' | 'enso' | 'castle' | 'bamboo';

const ART_SRC: Record<OnboardingArt, string> = {
  samurai: '/media/onboarding/samurai.webp',
  enso: '/media/onboarding/enso.webp',
  castle: '/media/onboarding/castle.webp',
  bamboo: '/media/onboarding/bamboo.webp',
};

const ART_ALT: Record<OnboardingArt, string> = {
  samurai: 'ink painting of a samurai',
  enso: 'an ink enso circle',
  castle: 'a castle in cherry blossoms',
  bamboo: 'ink bamboo stalks',
};

interface Step {
  readonly label: string;
  readonly matches: readonly string[];
  readonly art: OnboardingArt;
}

const STEPS_CREATE: readonly Step[] = [
  { label: 'welcome', matches: [PagePath.WELCOME], art: 'samurai' },
  { label: 'password', matches: [PagePath.SET_PASSWORD], art: 'samurai' },
  { label: 'secret phrase', matches: [PagePath.GENERATE_SEED_PHRASE], art: 'enso' },
  { label: 'done', matches: [PagePath.ONBOARDING_SUCCESS], art: 'castle' },
];

const STEPS_IMPORT: readonly Step[] = [
  { label: 'welcome', matches: [PagePath.WELCOME], art: 'bamboo' },
  { label: 'recovery phrase', matches: [PagePath.IMPORT_SEED_PHRASE], art: 'bamboo' },
  { label: 'review', matches: [PagePath.IMPORT_REVIEW], art: 'bamboo' },
  { label: 'when', matches: [PagePath.IMPORT_BIRTHDAY], art: 'bamboo' },
  { label: 'password', matches: [PagePath.SET_PASSWORD], art: 'bamboo' },
  { label: 'done', matches: [PagePath.ONBOARDING_SUCCESS], art: 'castle' },
];

const STEPS_ZIGNER: readonly Step[] = [
  { label: 'welcome', matches: [PagePath.WELCOME], art: 'enso' },
  { label: 'connect', matches: [PagePath.IMPORT_ZIGNER], art: 'enso' },
  { label: 'password', matches: [PagePath.SET_PASSWORD], art: 'enso' },
  { label: 'done', matches: [PagePath.ONBOARDING_SUCCESS], art: 'castle' },
];

const STEPS_LEDGER: readonly Step[] = [
  { label: 'welcome', matches: [PagePath.WELCOME], art: 'enso' },
  { label: 'connect', matches: [PagePath.CONNECT_LEDGER], art: 'enso' },
  { label: 'password', matches: [PagePath.SET_PASSWORD], art: 'enso' },
  { label: 'done', matches: [PagePath.ONBOARDING_SUCCESS], art: 'castle' },
];

function resolveSteps(pathname: string, origin: SEED_PHRASE_ORIGIN): readonly Step[] {
  if (pathname.startsWith(PagePath.IMPORT_ZIGNER)) {
    return STEPS_ZIGNER;
  }
  if (pathname.startsWith(PagePath.CONNECT_LEDGER)) {
    return STEPS_LEDGER;
  }
  if (pathname.startsWith(PagePath.IMPORT_SEED_PHRASE)) {
    return STEPS_IMPORT;
  }
  if (pathname === PagePath.SET_PASSWORD || pathname === PagePath.ONBOARDING_SUCCESS) {
    if (origin === SEED_PHRASE_ORIGIN.ZIGNER) {
      return STEPS_ZIGNER;
    }
    if (origin === SEED_PHRASE_ORIGIN.LEDGER) {
      return STEPS_LEDGER;
    }
    if (origin === SEED_PHRASE_ORIGIN.IMPORTED) {
      return STEPS_IMPORT;
    }
    return STEPS_CREATE;
  }
  return STEPS_CREATE;
}

/** shared back link - every screen but the first of its path renders one as
 * the first line of its content column (see OnboardingShell's doc comment). */
export function OnboardingBack({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='mb-1 flex items-center gap-1.5 self-start bg-transparent text-body text-fg-muted transition-colors hover:text-fg-high lowercase'
    >
      <span className='i-ph-arrow-left size-3.5' aria-hidden='true' />
      back
    </button>
  );
}

interface OnboardingShellProps {
  readonly children: React.ReactNode;
  /** overrides the pathname-derived art (the welcome/choose split and the
   * generate screen's internal phrase/check phases pick their own art). */
  readonly art?: OnboardingArt;
}

/**
 * The shell's top bar only carries the step progress (it doesn't know a
 * screen's back target - welcome/choose and generate/check are local phase
 * machines, not routes, so only the screen itself knows what "back" means at
 * a given moment). Each screen renders its own back link as the first line
 * of its content column instead - a deviation from the board, where back
 * sits in the top bar; reported in the PR.
 */
export function OnboardingShell({ children, art }: OnboardingShellProps) {
  const location = useLocation();
  const steps = resolveSteps(location.pathname, getSeedPhraseOrigin(location));
  const activeIdx = Math.max(
    0,
    steps.findIndex(s => s.matches.some(m => location.pathname === m)),
  );
  const isLast = activeIdx === steps.length - 1;
  const barCount = steps.length - 1;
  const resolvedArt = art ?? steps[activeIdx]!.art;

  return (
    <div className='flex min-h-screen w-full bg-canvas text-fg'>
      <aside className='relative hidden w-[620px] shrink-0 overflow-hidden border-r border-border-soft bg-elev-2 lg:block'>
        <img
          src={ART_SRC[resolvedArt]}
          alt={ART_ALT[resolvedArt]}
          className='absolute inset-0 h-full w-full object-cover'
        />
        <div className='absolute left-10 top-9 flex flex-col gap-2'>
          <Mark size={38} keyline />
          <span
            className='text-label tracking-[0.18em] text-fg-high lowercase'
            style={{ WebkitTextStroke: '3px var(--surface-canvas)', paintOrder: 'stroke fill' }}
          >
            shielded signing
          </span>
        </div>
      </aside>

      <section className='flex flex-1 flex-col px-6 py-10 sm:px-12 lg:px-24 lg:py-11'>
        <div className='flex h-11 shrink-0 items-center justify-end gap-4'>
          {!isLast && barCount > 0 && (
            <>
              <span className='text-label text-fg-muted lowercase'>
                step {activeIdx + 1} of {barCount}
              </span>
              <div className='flex gap-1'>
                {steps.slice(0, -1).map((s, i) => (
                  <span
                    key={s.label}
                    className={cn(
                      'h-[3px] w-9',
                      i <= activeIdx ? 'bg-zigner-gold' : 'bg-border-hard',
                    )}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className='flex flex-1 items-center'>
          <div className='w-full max-w-[460px]'>{children}</div>
        </div>
      </section>
    </div>
  );
}
