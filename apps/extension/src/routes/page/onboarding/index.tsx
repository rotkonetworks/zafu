/**
 * The onboarding layout - Onb1..Onb8 boards. One shell for every step, so
 * the art panel and the top bar stay put while only the column changes.
 * Chrome (art, back, step) comes from the route through `screenFor`.
 */

import { useState } from 'react';
import { Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { motion } from 'framer-motion';
import { cn } from '@repo/ui/lib/utils';
import { Mark } from '@repo/ui/components/ui/mark';
import { usePageNav } from '../../../utils/navigate';
import { screenFor, type OnboardingArt } from './flow';

const ART: Record<OnboardingArt, string> = {
  samurai: 'ink painting of a samurai',
  enso: 'an ink enso circle',
  castle: 'a castle in cherry blossoms',
  bamboo: 'ink bamboo stalks',
};

// the art fades into the page over its last 120px, as on the boards
const ART_FADE = { maskImage: 'linear-gradient(to right, #000 calc(100% - 120px), transparent)' };

/** What a path holds in memory until its password step seals it: the create
 *  path's password, the watch-only path's viewing key. */
export interface OnboardingContext {
  readonly password: string;
  readonly setPassword: (password: string) => void;
  readonly viewingKey: string;
  readonly setViewingKey: (key: string) => void;
}

export const useOnboarding = () => useOutletContext<OnboardingContext>();

export const Onboarding = () => {
  const { pathname } = useLocation();
  const navigate = usePageNav();
  const { art, back, step } = screenFor(pathname);
  const [password, setPassword] = useState('');
  const [viewingKey, setViewingKey] = useState('');

  return (
    <div className='flex min-h-screen w-full bg-canvas text-fg'>
      <aside className='relative hidden w-[620px] shrink-0 overflow-hidden lg:block'>
        {(Object.keys(ART) as OnboardingArt[]).map(a => (
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
          <span className='ml-[50px] text-[11px] tracking-[0.1em]'>shielded signing</span>
        </div>
      </aside>

      <section className='flex min-w-0 flex-1 flex-col px-6 pb-11 pt-10 lg:pl-[72px] lg:pr-24'>
        <div className='flex h-11 shrink-0 items-center gap-[18px]'>
          {back && (
            <button
              type='button'
              onClick={() => navigate(back)}
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

        <div className='flex flex-1 items-center'>
          <motion.div
            key={pathname}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.25, ease: 'easeOut' } }}
            className='w-[460px] max-w-full'
          >
            <Outlet
              context={
                { password, setPassword, viewingKey, setViewingKey } satisfies OnboardingContext
              }
            />
          </motion.div>
        </div>
      </section>
    </div>
  );
};
