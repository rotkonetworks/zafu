import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Mark } from '@repo/ui/components/ui/mark';
import { cn } from '@repo/ui/lib/utils';
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
  // key derivation (PBKDF2, 210k rounds) takes a visible beat on slow machines
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

  return (
    <div className='relative isolate flex h-full min-h-[628px] flex-col justify-center gap-[18px] bg-canvas px-7'>
      <img
        src='/media/emblem.webp'
        alt=''
        aria-hidden='true'
        className='pointer-events-none absolute left-1/2 top-10 -z-10 size-[260px] -translate-x-1/2 opacity-10'
      />
      <Mark variant='seal' size={54} className='self-center' />
      <h1 className='self-center font-display text-[26px] text-fg-high'>welcome back</h1>
      <span className='self-center text-[11px] tracking-[0.1em] text-fg-muted'>
        shielded signing
      </span>
      {undecryptable ? (
        <>
          <p className='text-body text-fg-muted'>
            this wallet&apos;s recovery data no longer opens with this password. your funds are safe
            - restoring its recovery phrase brings it back.
          </p>
          <Button onClick={() => navigate(PopupPath.SETTINGS_WALLETS)}>restore this wallet</Button>
          <Button variant='quiet' onClick={() => navigate(PopupPath.INDEX)}>
            continue for now
          </Button>
        </>
      ) : (
        <form onSubmit={handleUnlock} className='flex flex-col gap-[18px]'>
          <label htmlFor='unlock-password' className='sr-only'>
            password
          </label>
          <Input
            id='unlock-password'
            name='password'
            type='password'
            autoFocus
            autoComplete='current-password'
            variant={enteredIncorrect ? 'warn' : 'default'}
            value={input}
            onChange={e => {
              setInputValue(e.target.value);
              setEnteredIncorrect(false);
            }}
            className={cn(
              'h-[52px] px-3.5 text-[15px]',
              enteredIncorrect && 'focus-visible:border-warn',
            )}
          />
          <span className='h-[18px] text-label text-warning' aria-live='polite'>
            {enteredIncorrect ? "that doesn't match · please try again" : ''}
          </span>
          <Button type='submit' loading={unlocking} className='h-[52px] text-[15px]'>
            unlock
          </Button>
          <button
            type='button'
            onClick={() => navigate(PopupPath.FORGOT_PASSWORD)}
            className='self-center bg-transparent text-label text-fg-muted transition-colors hover:text-fg-high'
          >
            forgot it? restore with your recovery phrase
          </button>
        </form>
      )}
    </div>
  );
};
