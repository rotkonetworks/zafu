/**
 * OnboardingShell — split-view layout for the onboarding flow.
 *
 * Design intent: this is the user's *first* visual impression of zafu, so
 * we lean into the cozy/zen reading of the brand name (a zafu is a
 * meditation cushion). The wallet itself keeps its deliberate
 * terminal-angular identity; only this entry surface is round + soft.
 *
 * Layout (desktop tab):
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │  ┌──────────────────┐  ┌──────────────────────────┐   │
 *   │  │                  │  │                          │   │
 *   │  │   Brand rail     │  │   Step content           │   │
 *   │  │   + step list    │  │                          │   │
 *   │  │   (sidebar)      │  │   (right pane)           │   │
 *   │  │                  │  │                          │   │
 *   │  └──────────────────┘  └──────────────────────────┘   │
 *   └────────────────────────────────────────────────────────┘
 *
 * Performance notes:
 *   - Transitions are transform/opacity only; no layout-affecting props.
 *   - The stepper renders the full list always; the active item is keyed
 *     so React doesn't tear it down on navigation.
 *   - No big illustrations on first paint — a subtle radial-gradient
 *     "cushion" sits behind the content (cheap to paint).
 */

import { cn } from '@repo/ui/lib/utils';
import { useLocation } from 'react-router-dom';
import { PagePath } from '../paths';

export type OnboardingStepId =
  | 'welcome'
  | 'choose-path'
  | 'generate'
  | 'import'
  | 'import-zigner'
  | 'set-password'
  | 'select-networks'
  | 'success';

interface OnboardingStep {
  readonly id: OnboardingStepId;
  readonly label: string;
  /** Routes (PagePath values) that count as "this step" for stepper highlighting. */
  readonly matches: ReadonlyArray<string>;
}

/**
 * The visible stepper. Order = visual order. The wallet supports three
 * entry paths (create / import / zigner-airgap) but the user only
 * traverses one of them, so the stepper shows one path-specific step
 * dynamically (see resolveActiveStep).
 */
const STEPS_CREATE: ReadonlyArray<OnboardingStep> = [
  { id: 'welcome',        label: 'welcome',         matches: [PagePath.WELCOME] },
  { id: 'generate',       label: 'secret phrase',   matches: [PagePath.GENERATE_SEED_PHRASE] },
  { id: 'set-password',   label: 'password',        matches: [PagePath.SET_PASSWORD] },
  { id: 'select-networks',label: 'networks',        matches: [PagePath.SELECT_NETWORKS] },
  { id: 'success',        label: 'done',            matches: [PagePath.ONBOARDING_SUCCESS] },
];

const STEPS_IMPORT: ReadonlyArray<OnboardingStep> = [
  { id: 'welcome',        label: 'welcome',         matches: [PagePath.WELCOME] },
  { id: 'import',         label: 'recovery phrase', matches: [PagePath.IMPORT_SEED_PHRASE] },
  { id: 'set-password',   label: 'password',        matches: [PagePath.SET_PASSWORD] },
  { id: 'select-networks',label: 'networks',        matches: [PagePath.SELECT_NETWORKS] },
  { id: 'success',        label: 'done',            matches: [PagePath.ONBOARDING_SUCCESS] },
];

const STEPS_ZIGNER: ReadonlyArray<OnboardingStep> = [
  { id: 'welcome',        label: 'welcome',         matches: [PagePath.WELCOME] },
  { id: 'import-zigner',  label: 'connect zigner',  matches: [PagePath.IMPORT_ZIGNER] },
  { id: 'set-password',   label: 'password',        matches: [PagePath.SET_PASSWORD] },
  { id: 'select-networks',label: 'networks',        matches: [PagePath.SELECT_NETWORKS] },
  { id: 'success',        label: 'done',            matches: [PagePath.ONBOARDING_SUCCESS] },
];

function resolveSteps(pathname: string): ReadonlyArray<OnboardingStep> {
  if (pathname.startsWith(PagePath.IMPORT_ZIGNER)) return STEPS_ZIGNER;
  if (pathname.startsWith(PagePath.IMPORT_SEED_PHRASE)) return STEPS_IMPORT;
  // default to create — the welcome/password/networks/success steps are
  // identical, so users who haven't chosen a path yet still see a sensible
  // stepper.
  return STEPS_CREATE;
}

function resolveActiveStepIndex(
  steps: ReadonlyArray<OnboardingStep>,
  pathname: string,
): number {
  const idx = steps.findIndex(s => s.matches.some(m => pathname === m));
  return idx >= 0 ? idx : 0;
}

interface OnboardingShellProps {
  readonly children: React.ReactNode;
  /** Title shown at the top of the right pane (above children). */
  readonly title?: string;
  /** Optional sub-title under the title. */
  readonly subtitle?: string;
}

export function OnboardingShell({ children, title, subtitle }: OnboardingShellProps) {
  const { pathname } = useLocation();
  const steps = resolveSteps(pathname);
  const activeIdx = resolveActiveStepIndex(steps, pathname);

  return (
    <div className='relative min-h-screen w-full overflow-hidden bg-canvas text-fg'>
      {/* Soft radial "cushion" backdrop. transform-translate is gpu-cheap;
          we never animate the gradient itself. */}
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 z-0'
        style={{
          background:
            'radial-gradient(60% 50% at 25% 35%, color-mix(in oklch, var(--color-zigner-gold) 8%, transparent), transparent 70%), ' +
            'radial-gradient(45% 40% at 80% 75%, color-mix(in oklch, var(--color-zafu-blue) 6%, transparent), transparent 65%)',
        }}
      />

      <div className='relative z-10 mx-auto flex min-h-screen max-w-5xl items-stretch gap-6 px-6 py-8'>
        {/* Brand + stepper rail */}
        <aside className='hidden w-56 shrink-0 flex-col gap-8 pt-8 md:flex'>
          <BrandLockup />
          <Stepper steps={steps} activeIdx={activeIdx} />
        </aside>

        {/* Right pane: rounded "cushion" container */}
        <main
          className={cn(
            'flex-1 overflow-hidden',
            'border border-border-soft/60 bg-elev-1/80 backdrop-blur',
            // Cushion-evoking corner radius. Tailwind v4 zero-radius is the
            // baseline brand; we deliberately override here for onboarding only.
            '[border-radius:24px]',
            'shadow-[0_8px_40px_-12px_rgba(0,0,0,0.35)]',
          )}
        >
          <div className='flex h-full flex-col px-8 py-10 md:px-12'>
            {(title || subtitle) && (
              <header className='mb-6 flex flex-col gap-1'>
                {title && (
                  <h1 className='text-2xl tracking-[-0.01em] text-fg-high lowercase'>{title}</h1>
                )}
                {subtitle && (
                  <p className='text-xs text-fg-muted tracking-[0.02em]'>{subtitle}</p>
                )}
              </header>
            )}
            <div className='flex-1'>{children}</div>
          </div>
        </main>
      </div>
    </div>
  );
}

function BrandLockup() {
  return (
    <div className='flex flex-col gap-1'>
      <span className='text-3xl font-medium text-zigner-gold lowercase tracking-[-0.02em] leading-none'>
        zafu
      </span>
      <span className='mt-1 text-[11px] text-fg-muted tracking-[0.02em] lowercase'>
        shielded signing
      </span>
    </div>
  );
}

function Stepper({
  steps,
  activeIdx,
}: {
  readonly steps: ReadonlyArray<OnboardingStep>;
  readonly activeIdx: number;
}) {
  return (
    <ol className='flex flex-col gap-2.5'>
      {steps.map((s, i) => {
        const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';
        return (
          <li
            key={s.id}
            className={cn(
              'flex items-center gap-2.5 text-xs lowercase tracking-[0.02em] transition-opacity duration-200',
              state === 'pending' && 'opacity-40',
            )}
          >
            <span
              className={cn(
                'inline-flex h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200',
                state === 'done' && 'bg-zigner-gold/60',
                state === 'active' && 'bg-zigner-gold',
                state === 'pending' && 'bg-fg-muted/40',
              )}
            />
            <span
              className={cn(
                state === 'active' && 'text-fg-high',
                state === 'done' && 'text-fg',
                state === 'pending' && 'text-fg-muted',
              )}
            >
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
