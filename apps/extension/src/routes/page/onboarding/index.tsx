/**
 * The onboarding layout - Onb1..Onb8 boards. One shell for every step, so
 * the art panel and the top bar stay put while only the column changes.
 * Chrome (art, back, step) comes from the route through `screenFor`.
 */

import { useState } from 'react';
import { Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ScrollShell } from '../../../components/scroll-shell';
import { usePageNav } from '../../../utils/navigate';
import { useStore } from '../../../state';
import { screenFor } from './flow';

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
  const twelve = useStore(s => s.seedPhrase.import.phrase.length === 12);
  const { art, back, step } = screenFor(pathname, twelve);
  const [password, setPassword] = useState('');
  const [viewingKey, setViewingKey] = useState('');

  return (
    <ScrollShell
      art={art}
      label='shielded signing'
      back={back ? () => navigate(back) : undefined}
      step={step}
    >
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
    </ScrollShell>
  );
};
