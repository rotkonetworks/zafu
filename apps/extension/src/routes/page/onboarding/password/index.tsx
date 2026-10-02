/**
 * Set a password - Onb2Password board. The create path keeps it in memory and
 * moves on to the phrase; every other path seals the wallet here.
 */

import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { usePageNav } from '../../../../utils/navigate';
import { PagePath } from '../../paths';
import { PENDING_ZCASH_BIRTHDAY_KEY } from '../constants';
import { BIRTHDAY_PATH, originOf, passwordStrength, penumbraOnlyImport } from '../flow';
import { useOnboarding } from '..';
import { useFinalizeOnboarding } from './hooks';
import { useStore } from '../../../../state';
import { SEED_PHRASE_ORIGIN } from './types';

const STRENGTH = [
  ['', ''],
  ['weak', 'bg-warning'],
  ['fair', 'bg-zigner-gold'],
  ['strong', 'bg-green'],
  ['very strong', 'bg-green'],
] as const;

export const SetPassword = () => {
  const navigate = usePageNav();
  const origin = originOf(useLocation().pathname) ?? SEED_PHRASE_ORIGIN.IMPORTED;
  const onboarding = useOnboarding();
  // only the create path keeps a password to come back to
  const kept = origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED ? onboarding.password : '';
  const [password, setPassword] = useState(kept);
  const [again, setAgain] = useState(kept);
  const { finalize, error, loading } = useFinalizeOnboarding();
  const words = useStore(s => s.seedPhrase.import.phrase.length);

  // an import always carries a birthday from the step before; reached
  // without one (a reload, a typed url), go back and ask for it. Read once:
  // sealing the wallet clears it on the way out.
  const birthdayAt = penumbraOnlyImport(origin, words)
    ? undefined
    : (BIRTHDAY_PATH as Partial<Record<string, PagePath>>)[origin];
  const [needsBirthday] = useState(
    () => !!birthdayAt && !sessionStorage.getItem(PENDING_ZCASH_BIRTHDAY_KEY),
  );
  if (needsBirthday && birthdayAt) {
    return <Navigate to={birthdayAt} replace />;
  }
  // the viewing key lives in memory only; after a reload, ask for it again
  if (origin === SEED_PHRASE_ORIGIN.VIEWING_KEY && !onboarding.viewingKey) {
    return <Navigate to={PagePath.IMPORT_VIEWING_KEY} replace />;
  }

  const strength = passwordStrength(password);
  const [strengthLabel, strengthColor] = STRENGTH[strength]!;
  const match = again.length > 0 && again === password;
  const mismatch = again.length >= password.length && again.length > 0 && !match;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!match || loading) {
      return;
    }
    if (origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED) {
      onboarding.setPassword(password);
      navigate(PagePath.GENERATE_SEED_PHRASE);
      return;
    }
    void finalize(origin, password);
  };

  return (
    <form onSubmit={submit} className='flex flex-col gap-[22px]'>
      <h1 className='font-display text-[38px] text-fg-high'>set a password</h1>
      <p className='text-body text-fg-muted'>unlocks zafu on this computer</p>

      <div className='flex flex-col gap-2'>
        <label htmlFor='pw' className='text-label text-fg-muted'>
          password
        </label>
        <Input
          id='pw'
          type='password'
          autoFocus
          autoComplete='new-password'
          value={password}
          onChange={e => setPassword(e.target.value)}
          className='h-[54px] px-4 text-[15px]'
        />
        <div className='flex h-[18px] items-center gap-2' aria-live='polite'>
          {password && (
            <>
              <span className='flex gap-[3px]' aria-hidden='true'>
                {[1, 2, 3, 4].map(i => (
                  <span
                    key={i}
                    className={cn('h-[3px] w-7', i <= strength ? strengthColor : 'bg-border-hard')}
                  />
                ))}
              </span>
              <span className='text-[11px] text-fg-muted'>{strengthLabel}</span>
            </>
          )}
        </div>
      </div>

      <div className='flex flex-col gap-2'>
        <label htmlFor='pw-again' className='text-label text-fg-muted'>
          again
        </label>
        <Input
          id='pw-again'
          type='password'
          autoComplete='new-password'
          variant={mismatch ? 'warn' : 'default'}
          value={again}
          onChange={e => setAgain(e.target.value)}
          className='h-[54px] px-4 text-[15px]'
        />
        <span
          className={cn('h-[18px] text-[11px]', match ? 'text-green' : 'text-warning')}
          aria-live='polite'
        >
          {match ? 'they match' : mismatch ? "these don't match yet" : ''}
        </span>
      </div>

      <Button type='submit' disabled={!match} loading={loading} className='h-14 w-full text-[15px]'>
        continue
      </Button>
      <span className={cn('text-label', error ? 'text-warning' : 'text-fg-dim')}>
        {error ?? 'forgot it later? your recovery phrase restores the wallet'}
      </span>
    </form>
  );
};
