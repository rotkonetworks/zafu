/**
 * Onboarding entry — rendered inside OnboardingShell.
 *
 * The shell already provides the brand lockup, stepper, and rounded
 * pane. This screen focuses on the user's first decision: which path
 * to take into the wallet.
 *
 * Visual hierarchy:
 *   1. One sentence framing the choice ("how would you like to begin?")
 *   2. Three path cards (create / import / zigner) with one-line
 *      descriptions — the user picks by clicking the card itself, not
 *      a tiny button. Bigger hit-target, calmer feel.
 *   3. A muted-link footer for source + license.
 *
 * The dense info-card grid from the old design is removed — it was
 * marketing copy that distracted from the choice the user came here to
 * make. Those messages will re-appear contextually during the path-
 * specific steps (e.g., the FROST multisig copy under the create flow).
 */

import { useCallback } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';

interface PathOption {
  readonly icon: string;
  readonly label: string;
  readonly hint: string;
  readonly target: PagePath;
  readonly accent: 'gold' | 'blue';
}

const OPTIONS: ReadonlyArray<PathOption> = [
  {
    icon: 'i-lucide-sparkles',
    label: 'create a new wallet',
    hint: 'generate a fresh secret phrase on this device.',
    target: PagePath.GENERATE_SEED_PHRASE,
    accent: 'gold',
  },
  {
    icon: 'i-lucide-key',
    label: 'import a recovery phrase',
    hint: '24 words from an existing wallet. no server roundtrip.',
    target: PagePath.IMPORT_SEED_PHRASE,
    accent: 'gold',
  },
  {
    icon: 'i-lucide-smartphone',
    label: 'connect zigner (airgap)',
    hint: 'keep keys on your phone. sign by QR.',
    target: PagePath.IMPORT_ZIGNER,
    accent: 'blue',
  },
];

export const OnboardingStart = () => {
  const navigate = usePageNav();
  const go = useCallback((p: PagePath) => () => navigate(p), [navigate]);

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            how would you like to begin?
          </h2>
          <p className='text-xs text-fg-muted lowercase tracking-[0.02em]'>
            your keys stay on this device. always.
          </p>
        </header>

        <ul className='flex flex-col gap-2.5'>
          {OPTIONS.map(opt => (
            <li key={opt.target}>
              <PathCard option={opt} onClick={go(opt.target)} />
            </li>
          ))}
        </ul>

        <footer className='mt-auto flex items-center gap-4 pt-6 text-[10px] tracking-[0.05em] text-fg-muted lowercase'>
          <a
            href='https://rotko.net'
            target='_blank'
            rel='noopener noreferrer'
            className='transition-colors hover:text-fg-high'
          >
            rotko.net
          </a>
          <span className='text-fg-muted/40'>·</span>
          <a
            href='https://github.com/rotkonetworks/zafu'
            target='_blank'
            rel='noopener noreferrer'
            className='transition-colors hover:text-fg-high'
          >
            source
          </a>
          <span className='text-fg-muted/40'>·</span>
          <span className='text-fg-muted/60'>gpl-3.0</span>
        </footer>
      </div>
    </FadeTransition>
  );
};

interface PathCardProps {
  readonly option: PathOption;
  readonly onClick: () => void;
}

const PathCard = ({ option, onClick }: PathCardProps) => {
  const isBlue = option.accent === 'blue';
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'group relative flex w-full items-center gap-4 overflow-hidden text-left',
        'border border-border-soft/60 bg-elev-2/40 px-5 py-4',
        // cushion radius — local to onboarding, doesn't touch the wallet
        // theme's deliberate zero-radius identity.
        '[border-radius:16px]',
        // smooth transition on transform/opacity only; no layout-affecting
        // hover effects (no scale + width changes, no margin shifts).
        'transition-[transform,border-color,background-color] duration-200',
        'hover:-translate-y-[1px] hover:border-border-soft',
        isBlue ? 'hover:bg-zafu-blue/[0.06]' : 'hover:bg-zigner-gold/[0.06]',
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          isBlue ? 'bg-zafu-blue/15 text-zafu-blue' : 'bg-zigner-gold/15 text-zigner-gold',
        )}
      >
        <span className={cn(option.icon, 'h-4 w-4')} />
      </span>
      <span className='flex flex-1 flex-col'>
        <span className='text-sm lowercase tracking-[0.01em] text-fg-high'>{option.label}</span>
        <span className='mt-0.5 text-[11px] text-fg-muted lowercase tracking-[0.02em]'>
          {option.hint}
        </span>
      </span>
      <span
        className={cn(
          'i-lucide-arrow-right h-4 w-4 shrink-0 text-fg-muted',
          'transition-transform duration-200',
          'group-hover:translate-x-0.5',
          isBlue ? 'group-hover:text-zafu-blue' : 'group-hover:text-zigner-gold',
        )}
      />
    </button>
  );
};
