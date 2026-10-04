/**
 * The full-page tab shell from the boards (Onb1..8, Buy 0..4): an ink
 * painting on the left fading into the page, the seal and a quiet label over
 * it, then a column with back on the left and the step bars on the right.
 * Onboarding and the buy page draw it; only the column changes per step.
 */

import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Mark } from '@repo/ui/components/ui/mark';

export type ScrollArt = 'samurai' | 'enso' | 'castle' | 'bamboo';

const ART: Record<ScrollArt, string> = {
  samurai: 'ink painting of a samurai',
  enso: 'an ink enso circle',
  castle: 'a castle in cherry blossoms',
  bamboo: 'ink bamboo stalks',
};

// the art fades into the page over its last 120px, as on the boards
const ART_FADE = { maskImage: 'linear-gradient(to right, #000 calc(100% - 120px), transparent)' };

export const ScrollShell = ({
  art,
  label,
  back,
  step,
  aside = 'w-[620px]',
  children,
}: {
  art: ScrollArt;
  label: string;
  back?: () => void;
  /** [current (1-based), total, its name] */
  step?: readonly [number, number, string?];
  /** the art panel's width */
  aside?: string;
  children: ReactNode;
}) => (
  <div className='flex min-h-screen w-full bg-canvas text-fg'>
    <aside className={cn('relative hidden shrink-0 overflow-hidden lg:block', aside)}>
      {(Object.keys(ART) as ScrollArt[]).map(a => (
        <img
          key={a}
          src={`/media/onboarding/${a}.webp`}
          alt={a === art ? ART[a] : ''}
          style={ART_FADE}
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-400',
            a === art ? 'opacity-100' : 'opacity-0',
          )}
        />
      ))}
      <div className='absolute left-10 top-9 flex flex-col gap-1 text-zigner-gold-foreground'>
        <span className='flex items-center gap-3'>
          <Mark variant='seal' size={38} />
          <Mark
            variant='mono'
            content='wordmark'
            size={38}
            className='text-zigner-gold-foreground'
          />
        </span>
        <span className='ml-[50px] text-[11px] tracking-[0.1em]'>{label}</span>
      </div>
    </aside>

    <section className='flex min-w-0 flex-1 flex-col px-6 pb-11 pt-10 lg:pl-[72px] lg:pr-24'>
      <div className='flex h-11 shrink-0 items-center gap-[18px]'>
        {back && (
          <button
            type='button'
            onClick={back}
            className='flex items-center gap-1.5 bg-transparent text-data text-fg-muted transition-colors hover:text-fg-high'
          >
            <span className='i-lucide-chevron-left size-4' aria-hidden='true' />
            back
          </button>
        )}
        <span className='flex-1' />
        {step && (
          <>
            <span className='text-label text-fg-muted'>
              step {step[0]} of {step[1]}
              {step[2] && ` · ${step[2]}`}
            </span>
            <span className='flex gap-1' aria-hidden='true'>
              {Array.from({ length: step[1] }, (_, i) => (
                <span
                  key={i}
                  className={cn('h-[3px] w-9', i < step[0] ? 'bg-zigner-gold' : 'bg-border-hard')}
                />
              ))}
            </span>
          </>
        )}
      </div>
      {children}
    </section>
  </div>
);
