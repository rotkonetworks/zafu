/**
 * Set-password - last user-input step before the wallet is sealed. Lives
 * inside OnboardingShell now, so this screen only renders the form +
 * primary action. The shell provides the rounded pane, brand rail and
 * stepper.
 *
 * For new users the password is the *only* thing standing between a
 * compromised local context and their seed phrase, so the copy is
 * deliberately honest - not "secure your wallet" boilerplate but the
 * actual concrete thing the password does.
 */

import { FormEvent, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { cn } from '@repo/ui/lib/utils';
import { usePageNav } from '../../../../utils/navigate';
import { PasswordInput } from '../../../../shared/components/password-input';
import { useFinalizeOnboarding } from './hooks';
import { PagePath } from '../../paths';
import { SEED_PHRASE_ORIGIN } from './types';
import { getSeedPhraseOrigin } from './utils';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../../config/networks';
import { dateToBlock, blockToDate, formatDateInput } from '../../../../utils/zcash-blocks';

export const SetPassword = () => {
  const navigate = usePageNav();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { handleSubmit, error, loading } = useFinalizeOnboarding();

  const location = useLocation();
  const origin = getSeedPhraseOrigin(location);
  const isImport = origin === SEED_PHRASE_ORIGIN.IMPORTED;

  // zcash wallet birthday - only relevant for *imported* wallets. A fresh
  // wallet has no prior history, so the worker starts from chain tip. Moved
  // here from the old select-networks screen; useFinalizeOnboarding reads the
  // stashed value after the wallet exists.
  const [zcashBirthday, setZcashBirthday] = useState('');
  const [zcashDate, setZcashDate] = useState('');
  const [inputMode, setInputMode] = useState<'date' | 'block'>('date');

  const handleFormSubmit = (e: FormEvent) => {
    // stash the birthday for useFinalizeOnboarding. Round down to the nearest
    // 10k then drop one more 10k so we always start before the real birthday
    // (the date->block estimate can drift a few thousand blocks ahead).
    if (isImport && zcashBirthday) {
      const num = parseInt(zcashBirthday, 10);
      if (!isNaN(num) && num >= ZCASH_ORCHARD_ACTIVATION) {
        const rounded = Math.floor(num / 10_000) * 10_000 - 10_000;
        sessionStorage.setItem(
          'pendingZcashBirthday',
          String(Math.max(rounded, ZCASH_ORCHARD_ACTIVATION)),
        );
      }
    }
    void handleSubmit(e, password);
  };

  // Soft floor - currently 1 (only an empty password is rejected). The
  // seed phrase is the real root of trust; the password just gates
  // local-at-rest access to the encrypted vault. We don't want to
  // paternalize the throwaway/test-wallet case or fight sophisticated
  // users who know their threat model. Constant kept here so the
  // floor is one number to change if that calculus shifts.
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
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <button
            type='button'
            onClick={onBack}
            className='mb-2 inline-flex items-center gap-1.5 self-start text-body text-fg-muted transition-colors hover:text-fg-high lowercase'
          >
            <span className='i-ph-arrow-left h-3 w-3' />
            back
          </button>
          <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>set a password</h2>
          <p className='text-xs text-fg-muted lowercase leading-snug'>
            encrypts your seed phrase on this device. you'll enter it again every time the wallet
            locks. there's no way to recover it - pick something you'll remember.
          </p>
        </header>

        <form onSubmit={handleFormSubmit} className='flex flex-col gap-3'>
          <PasswordInput
            passwordValue={password}
            label='new password'
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

          {isImport && (
            <div className='mt-1 rounded-lg border border-border-soft p-3'>
              <div className='flex items-center justify-between mb-2'>
                <span className='text-xs font-medium lowercase'>zcash wallet birthday</span>
                <button
                  type='button'
                  onClick={() => setInputMode(inputMode === 'date' ? 'block' : 'date')}
                  className='text-label text-fg-muted hover:text-fg-high transition-colors'
                >
                  {inputMode === 'date' ? 'enter block instead' : 'enter date instead'}
                </button>
              </div>

              {inputMode === 'date' ? (
                <input
                  type='date'
                  min={formatDateInput(blockToDate(ZCASH_ORCHARD_ACTIVATION))}
                  max={formatDateInput(new Date())}
                  value={zcashDate}
                  onChange={e => {
                    setZcashDate(e.target.value);
                    if (e.target.value) {
                      setZcashBirthday(String(dateToBlock(new Date(e.target.value + 'T00:00:00Z'))));
                    } else {
                      setZcashBirthday('');
                    }
                  }}
                  className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
                />
              ) : (
                <input
                  type='number'
                  min={ZCASH_ORCHARD_ACTIVATION}
                  step='10000'
                  value={zcashBirthday}
                  onChange={e => {
                    setZcashBirthday(e.target.value);
                    const num = parseInt(e.target.value, 10);
                    if (!isNaN(num) && num >= ZCASH_ORCHARD_ACTIVATION) {
                      setZcashDate(formatDateInput(blockToDate(num)));
                    }
                  }}
                  placeholder='leave blank to sync from chain tip'
                  className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
                />
              )}

              {zcashBirthday && (
                <p className='mt-1.5 text-label text-fg-muted'>
                  ~zcash mainnet block {Number(zcashBirthday).toLocaleString()}
                  {zcashDate && ` (~${zcashDate})`}
                </p>
              )}
              <p className='mt-1 text-label text-fg-muted lowercase'>
                approximate date the wallet was first used. rounded for privacy. skip this if you
                don't know - scanning starts from chain tip.
              </p>
            </div>
          )}

          <button
            type='submit'
            disabled={!canSubmit}
            className={cn(
              'group mt-2 inline-flex items-center justify-center gap-2 px-5 py-3 text-sm lowercase',
              '[border-radius:14px] border transition-[transform,opacity,background-color,border-color] duration-200',
              canSubmit
                ? 'border-zigner-gold/30 bg-zigner-gold/10 text-zigner-gold hover:-translate-y-[1px] hover:bg-zigner-gold/15'
                : 'cursor-not-allowed border-border-soft/60 bg-elev-2/30 text-fg-muted',
            )}
          >
            {loading ? 'sealing wallet…' : 'continue'}
            {canSubmit && !loading && (
              <span className='i-ph-arrow-right h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5' />
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
