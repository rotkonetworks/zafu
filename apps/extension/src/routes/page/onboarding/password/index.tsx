/**
 * Set-password — last user-input step before the wallet is sealed. Lives
 * inside OnboardingShell now, so this screen only renders the form +
 * primary action. The shell provides the rounded pane, brand rail and
 * stepper.
 *
 * For new users the password is the *only* thing standing between a
 * compromised local context and their seed phrase, so the copy is
 * deliberately honest — not "secure your wallet" boilerplate but the
 * actual concrete thing the password does.
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { cn } from '@repo/ui/lib/utils';
import { usePageNav } from '../../../../utils/navigate';
import { PasswordInput } from '../../../../shared/components/password-input';
import { useFinalizeOnboarding } from './hooks';
import { PagePath } from '../../paths';
import { SEED_PHRASE_ORIGIN } from './types';
import { getSeedPhraseOrigin } from './utils';

export const SetPassword = () => {
  const navigate = usePageNav();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { handleSubmit, error, loading } = useFinalizeOnboarding();

  const location = useLocation();
  const origin = getSeedPhraseOrigin(location);

  const canSubmit = password.length > 0 && password === confirmation && !loading;
  const onBack = () => {
    if (origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED) {
      navigate(PagePath.WELCOME);
    } else {
      navigate(-1);
    }
  };

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <button
            type='button'
            onClick={onBack}
            className='mb-2 inline-flex items-center gap-1.5 self-start text-[11px] text-fg-muted transition-colors hover:text-fg-high lowercase tracking-[0.02em]'
          >
            <span className='i-lucide-arrow-left h-3 w-3' />
            back
          </button>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>
            set a password
          </h2>
          <p className='text-xs text-fg-muted lowercase tracking-[0.02em] leading-snug'>
            encrypts your seed phrase on this device. you'll enter it
            again every time the wallet locks. there's no way to recover
            it — pick something you'll remember.
          </p>
        </header>

        <form
          onSubmit={e => void handleSubmit(e, password)}
          className='flex flex-col gap-3'
        >
          <PasswordInput
            passwordValue={password}
            label='new password'
            onChange={({ target: { value } }) => setPassword(value)}
          />
          <PasswordInput
            passwordValue={confirmation}
            label='confirm password'
            onChange={({ target: { value } }) => setConfirmation(value)}
            validations={[
              {
                type: 'warn',
                issue: "passwords don't match",
                checkFn: (txt: string) => password !== txt,
              },
            ]}
          />

          <button
            type='submit'
            disabled={!canSubmit}
            className={cn(
              'group mt-2 inline-flex items-center justify-center gap-2 px-5 py-3 text-sm lowercase tracking-[0.01em]',
              '[border-radius:14px] border transition-[transform,opacity,background-color,border-color] duration-200',
              canSubmit
                ? 'border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold hover:-translate-y-[1px] hover:bg-zigner-gold/15'
                : 'cursor-not-allowed border-border-soft/60 bg-elev-2/30 text-fg-muted',
            )}
          >
            {loading ? 'sealing wallet…' : 'continue'}
            {canSubmit && !loading && (
              <span className='i-lucide-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
            )}
          </button>

          {error && (
            <div className='rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400 lowercase'>
              {error}
            </div>
          )}
        </form>
      </div>
    </FadeTransition>
  );
};
