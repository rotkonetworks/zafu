import { useEffect, useState } from 'react';
import { PasswordInput } from '../../../shared/components/password-input';
import { QrCode } from '../../../components/qr-code';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { walletsSelector } from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';

/** blurred words re-cover after this long, so a phrase left open on screen
 *  does not stay legible past a glance (SetPhrase.dc.html). */
const RECOVER_AFTER_MS = 60_000;

export const SettingsPassphrase = () => {
  const { isPassword } = useStore(passwordSelector);
  const { getSeedPhrase } = useStore(walletsSelector);

  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // re-cover automatically; only ticking while actually revealed, and reset
  // whenever the user asks to see the words again.
  useEffect(() => {
    if (!revealed) {
      return;
    }
    const t = setTimeout(() => setRevealed(false), RECOVER_AFTER_MS);
    return () => clearTimeout(t);
  }, [revealed]);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    void (async function () {
      try {
        if (await isPassword(password)) {
          setPassword('');
          setPhrase(await getSeedPhrase());
          // revealing the phrase counts as possessing it - clear the home nudge
          void localExtStorage.set('seedPhraseBackedUp', true);
        } else {
          setWrong(true);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to retrieve passphrase');
      }
    })();
  };

  const shown = phrase.length > 0;

  return (
    <SettingsScreen title='recovery phrase' backPath={PopupPath.SETTINGS_SECURITY}>
      <div className='flex flex-col gap-4'>
        {!shown ? (
          <form onSubmit={submit} className='flex flex-col gap-3'>
            <p className='text-sm text-fg-muted'>
              anyone who sees these words can take the wallet. please make sure you are alone.
            </p>
            <PasswordInput
              passwordValue={password}
              label={<p className='text-sm text-fg-muted'>password</p>}
              onChange={e => {
                setPassword(e.target.value);
                setWrong(false);
              }}
              validations={[
                {
                  type: 'error',
                  issue: "that doesn't match - please try again, slowly",
                  checkFn: (txt: string) => Boolean(txt) && wrong,
                },
              ]}
              autoFocus
            />
            {error && <p className='text-xs text-hanko-light'>{error}</p>}
            <Button type='submit' variant='primary' size='md' disabled={!password}>
              continue
            </Button>
          </form>
        ) : (
          <div className='flex flex-col gap-3'>
            <PhraseGrid words={phrase} revealed={revealed} onReveal={() => setRevealed(true)} />
            <Button variant='secondary' size='md' onClick={() => setRevealed(v => !v)}>
              {revealed ? 'hide' : 'show'}
            </Button>
            <p className='text-label text-fg-muted'>
              {revealed ? 'zafu covers them again after a minute' : 'blurred until you ask'}
            </p>

            {/* backup to zigner - the seed goes INTO the air gap, never out */}
            <div className='mt-1 border-t border-border-soft pt-3'>
              <p className='text-label text-fg-dim mb-2'>
                scan with zigner to back up this seed on your air-gapped device.
              </p>
              <QrSeedDisplay phrase={phrase.join(' ')} />
            </div>
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};

/** the 24-word grid, blurred by default with a "show the words" overlay -
 *  no copy affordance anywhere (feedback_never_print_secret_files applies
 *  to a seed phrase too: never make it one click to exfiltrate). Also used
 *  by settings-wallets.tsx's per-wallet export-recovery-phrase reveal, so
 *  that path never grows a copy button either. */
export const PhraseGrid = ({
  words,
  revealed,
  onReveal,
}: {
  words: string[];
  revealed: boolean;
  onReveal: () => void;
}) => (
  <div className='relative border border-border-soft bg-canvas'>
    <ol
      className={cn(
        'grid grid-cols-3 gap-x-2 gap-y-1 p-3 transition-[filter] duration-200',
        !revealed && 'blur-sm select-none pointer-events-none',
      )}
    >
      {words.map((word, i) => (
        <li key={i} className='flex items-baseline gap-1.5 py-1 text-xs'>
          <span className='w-4 shrink-0 text-right text-label tabular text-fg-dim'>{i + 1}</span>
          <span className='text-fg-high'>{word}</span>
        </li>
      ))}
    </ol>
    {!revealed && (
      <button
        type='button'
        onClick={onReveal}
        className='absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas/40 text-sm text-fg-high'
      >
        <span className='i-ph-eye size-5 text-zigner-gold' aria-hidden='true' />
        show the words
      </button>
    )}
  </div>
);

/** QR code showing seed phrase for zigner backup import - gated behind an
 * explicit show/hide, same as the seed phrase text itself. The phrase is
 * sensitive but displayed only on user action; never a copy affordance. */
const QrSeedDisplay = ({ phrase }: { phrase: string }) => {
  const [show, setShow] = useState(false);

  if (!show) {
    return (
      <Button variant='secondary' size='md' className='w-full' onClick={() => setShow(true)}>
        show QR for zigner backup
      </Button>
    );
  }

  return (
    <div className='flex flex-col items-center gap-2'>
      <QrCode value={phrase} size={200} label='seed phrase QR for zigner backup' />
      <p className='text-label text-fg-muted text-center'>
        scan with zigner camera to import seed. close this screen when done.
      </p>
      <Button variant='secondary' size='sm' onClick={() => setShow(false)}>
        hide QR
      </Button>
    </div>
  );
};
