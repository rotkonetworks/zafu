import { Button } from '@repo/ui/components/ui/button';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { InputProps } from '@repo/ui/components/ui/input';
import { PasswordInput } from '../../shared/components/password-input';
import { usePopupNav } from '../../utils/navigate';
import { useStore } from '../../state';
import { passwordSelector } from '../../state/password';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../state/keyring';
import { FormEvent, useState } from 'react';
import { PopupPath } from './paths';
import { needsOnboard, safeNext } from './popup-needs';
import { useLocation, useNavigate } from 'react-router-dom';

export const popupLoginLoader = () => needsOnboard();

export const Login = () => {
  const navigate = usePopupNav();
  const routerNavigate = useNavigate();
  const location = useLocation();

  const { isPassword, setSessionPassword } = useStore(passwordSelector);
  const activeKeyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const [input, setInputValue] = useState('');
  const [enteredIncorrect, setEnteredIncorrect] = useState(false);
  // Set when the password is correct (unlock succeeds) but the active wallet's
  // seed is sealed under a stale password key and cannot be decrypted. The
  // wallet is not lost - the user re-imports its recovery phrase. We never
  // mutate or delete anything here.
  const [undecryptable, setUndecryptable] = useState(false);
  // Key derivation (PBKDF2, 210k rounds) takes a visible beat on slower
  // machines. Without feedback the button reads as dead and users mash it.
  const [unlocking, setUnlocking] = useState(false);

  const handleUnlock = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (unlocking) {
      return;
    }
    setUnlocking(true);

    void (async function () {
      try {
        if (await isPassword(input)) {
          await setSessionPassword(input); // saves to session state
          // Probe the active vault before navigating: the global password is
          // right, but this vault's seed may be sealed under a stale key (e.g.
          // created before a password change) and throw 'failed to decrypt
          // vault'. Surface that gracefully instead of leaving the home screen
          // to spew console errors. Other wallets may be fine, so we don't hard
          // block - we offer re-import or continue.
          if (activeKeyInfo?.type === 'mnemonic') {
            try {
              await getMnemonic(activeKeyInfo.id); // result intentionally discarded
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes('failed to decrypt vault')) {
                setUndecryptable(true);
                return;
              }
              // any other derivation failure is not an unlock problem - proceed
            }
          }
          // back to the screen that sent us here (lockedScreenGuard), if any
          const next = safeNext(new URLSearchParams(location.search).get('next'));
          if (next) {
            routerNavigate(next, { replace: true });
          } else {
            navigate(PopupPath.INDEX);
          }
        } else {
          setEnteredIncorrect(true);
        }
      } finally {
        setUnlocking(false);
      }
    })();
  };

  const handleChangePassword: InputProps['onChange'] = e => {
    setInputValue(e.target.value);
    setEnteredIncorrect(false);
  };

  return (
    <FadeTransition className='flex flex-col items-stretch justify-start'>
      <div className='flex h-screen flex-col justify-between p-[30px] pt-10'>
        <div className='mx-auto my-0 flex flex-col items-center gap-1'>
          <span className='text-label tracking-[0.18em] text-fg-muted lowercase'>
            shielded signing
          </span>
          <h1 className='text-display text-zigner-gold lowercase tracking-[-0.01em] leading-none'>
            zafu
          </h1>
        </div>
        {undecryptable ? (
          <div className='grid gap-4'>
            <p className='text-title text-fg-high lowercase tracking-[-0.01em]'>
              this wallet can't be unlocked
            </p>
            <p className='text-body text-fg-muted lowercase'>
              its recovery data can no longer be decrypted with this password. your funds aren't
              lost - re-import this wallet's recovery phrase to restore it.
            </p>
            <Button
              size='lg'
              variant='gradient'
              type='button'
              onClick={() => navigate(PopupPath.SETTINGS_WALLETS)}
            >
              re-import wallet
            </Button>
            <Button
              size='sm'
              variant='ghost'
              type='button'
              onClick={() => navigate(PopupPath.INDEX)}
            >
              continue anyway
            </Button>
          </div>
        ) : (
          <form onSubmit={handleUnlock} className='grid gap-4'>
            <PasswordInput
              autoFocus
              name='password'
              passwordValue={input}
              label={
                <p className='text-title text-fg-high lowercase tracking-[-0.01em]'>
                  enter password
                </p>
              }
              onChange={handleChangePassword}
              validations={[
                {
                  type: 'error',
                  issue: 'wrong password',
                  checkFn: () => enteredIncorrect,
                },
              ]}
            />
            <Button
              size='lg'
              variant='gradient'
              disabled={enteredIncorrect || unlocking}
              type='submit'
            >
              {unlocking ? 'unlocking\u2026' : 'unlock'}
            </Button>
            {/* New users who hit a wrong password without a hint of
              recourse assume their wallet is gone. The line only
              surfaces after a failed attempt so we don't preemptively
              teach the wrong mental model — but the moment anxiety
              kicks in, the recovery path is visible. */}
            {enteredIncorrect && (
              <p className='text-center text-body text-fg-muted lowercase'>
                your funds aren't lost — you can restore from your seed phrase by reinstalling zafu.
              </p>
            )}
          </form>
        )}
        <div className='flex flex-col gap-1'>
          <p className='text-center text-xs text-fg-muted lowercase'>
            need help?{' '}
            <a
              className='cursor-pointer text-teal hover:underline transition-colors'
              href='https://discord.gg/zcash'
              target='_blank'
              rel='noreferrer'
            >
              chat with us
            </a>
          </p>
          <p className='text-center text-label text-fg-muted/50 tabular'>
            {BUILD_COMMIT}-{BUILD_DATE}
          </p>
        </div>
      </div>
    </FadeTransition>
  );
};
