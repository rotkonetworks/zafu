/**
 * Set-password - Onb2Password board. Last user-input step before the
 * wallet is sealed.
 */

import { FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { usePageNav } from '../../../../utils/navigate';
import { PasswordInput } from '../../../../shared/components/password-input';
import { useFinalizeOnboarding } from './hooks';
import { PagePath } from '../../paths';
import { SEED_PHRASE_ORIGIN } from './types';
import { getSeedPhraseOrigin } from './utils';
import { PENDING_ZCASH_BIRTHDAY_KEY } from '../constants';
import { OnboardingBack, OnboardingShell, type OnboardingArt } from '../onboarding-shell';

const ART_BY_ORIGIN: Record<SEED_PHRASE_ORIGIN, OnboardingArt> = {
  [SEED_PHRASE_ORIGIN.NEWLY_GENERATED]: 'samurai',
  [SEED_PHRASE_ORIGIN.IMPORTED]: 'bamboo',
  [SEED_PHRASE_ORIGIN.ZIGNER]: 'enso',
  [SEED_PHRASE_ORIGIN.LEDGER]: 'enso',
};

export const SetPassword = () => {
  const navigate = usePageNav();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { handleSubmit, error, loading } = useFinalizeOnboarding();

  const location = useLocation();
  const origin = getSeedPhraseOrigin(location);

  // An imported zcash recovery always needs a birthday (imports are zcash-only
  // - see import-review.tsx); bounce back if this screen is reached without
  // one stashed (direct URL, or a back-then-forward past the birthday step).
  useEffect(() => {
    if (
      origin === SEED_PHRASE_ORIGIN.IMPORTED &&
      !sessionStorage.getItem(PENDING_ZCASH_BIRTHDAY_KEY)
    ) {
      navigate(PagePath.IMPORT_BIRTHDAY);
    }
  }, [origin, navigate]);

  const handleFormSubmit = (e: FormEvent) => {
    void handleSubmit(e, password);
  };

  const MIN_PASSWORD_LENGTH = 1;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const canSubmit = password.length >= MIN_PASSWORD_LENGTH && password === confirmation && !loading;
  const onBack = () => {
    if (origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED) {
      navigate(PagePath.WELCOME);
    } else {
      navigate(-1);
    }
  };

  return (
    <OnboardingShell art={ART_BY_ORIGIN[origin]}>
      <FadeTransition>
        <div className='flex flex-col gap-[22px]'>
          <OnboardingBack onClick={onBack} />
          <h1 className='font-display text-[38px] font-medium text-fg-high'>set a password</h1>
          <p className='text-body text-fg-muted lowercase'>unlocks zafu on this computer</p>

          <form onSubmit={handleFormSubmit} className='flex flex-col gap-4'>
            <PasswordInput
              passwordValue={password}
              label='password'
              autoFocus
              onChange={({ target: { value } }) => setPassword(value)}
              validations={[
                {
                  type: 'warn',
                  issue: `at least ${MIN_PASSWORD_LENGTH} characters`,
                  checkFn: () => tooShort,
                },
              ]}
            />
            <PasswordInput
              passwordValue={confirmation}
              label='again'
              onChange={({ target: { value } }) => setConfirmation(value)}
              validations={[
                {
                  type: 'warn',
                  issue: "passwords don't match",
                  checkFn: (txt: string) => password !== txt,
                },
              ]}
            />

            <Button
              type='submit'
              variant='primary'
              disabled={!canSubmit}
              loading={loading}
              className='h-14 w-full text-body'
            >
              continue
            </Button>

            {error && (
              <StatusSlot tone='danger' icon='i-ph-warning'>
                {error}
              </StatusSlot>
            )}
          </form>

          <span className='text-label text-fg-dim lowercase'>
            forgot it later? your recovery phrase restores the wallet
          </span>
        </div>
      </FadeTransition>
    </OnboardingShell>
  );
};
