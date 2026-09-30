import { useState } from 'react';
import { PasswordInput } from '../../../shared/components/password-input';
import { QrCode } from '../../../components/qr-code';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { walletsSelector } from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { SeedPhraseBox } from '../../../components/seed-phrase-box';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';

export const SettingsPassphrase = () => {
  const { isPassword } = useStore(passwordSelector);
  const { getSeedPhrase } = useStore(walletsSelector);

  const [password, setPassword] = useState('');
  const [enteredIncorrect, setEnteredIncorrect] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    void (async function () {
      try {
        if (await isPassword(password)) {
          setPassword('');
          setPhrase(await getSeedPhrase());
          // revealing the phrase counts as possessing it — clear the home nudge
          void localExtStorage.set('seedPhraseBackedUp', true);
        } else {
          setEnteredIncorrect(true);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to retrieve passphrase');
      }
    })();
  };

  return (
    <SettingsScreen title='recovery passphrase' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <p className='text-sm text-fg-muted'>
          if you change browser or switch to another computer, you will need this recovery
          passphrase to access your accounts.
        </p>
        <p className='flex items-center gap-2 text-xs text-rust'>
          <span className='i-ph-warning size-4' />
          don't share this phrase with anyone
        </p>

        {!phrase.length ? (
          <form onSubmit={submit} className='flex flex-col gap-3'>
            <PasswordInput
              passwordValue={password}
              label={<p className='text-sm text-fg-muted'>password</p>}
              onChange={e => {
                setPassword(e.target.value);
                setEnteredIncorrect(false);
              }}
              validations={[
                {
                  type: 'error',
                  issue: 'wrong password',
                  checkFn: (txt: string) => Boolean(txt) && enteredIncorrect,
                },
              ]}
            />
            {error && <p className='text-xs text-rust'>{error}</p>}
            <button
              type='submit'
              className='w-full rounded-lg bg-zigner-gold py-2.5 text-sm text-zigner-gold-foreground transition-colors hover:bg-primary/90'
            >
              confirm
            </button>
          </form>
        ) : (
          <div className='flex flex-col gap-3'>
            <div className='flex items-center gap-2 text-label text-fg-dim font-mono'>
              <span className='h-2 w-2 rounded-full bg-yellow-400' />
              hot wallet — seed is in browser memory
            </div>
            <SeedPhraseBox phrase={phrase} />

            {/* backup to zigner */}
            <div className='border-t border-border-soft pt-3 mt-1'>
              <p className='text-label text-fg-dim font-mono mb-2'>
                scan with zigner to back up this seed on your air-gapped device. the seed goes INTO
                the air gap — never out.
              </p>
              <QrSeedDisplay phrase={phrase.join(' ')} />
            </div>
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};

/** QR code showing seed phrase for zigner backup import - gated behind an
 * explicit show/hide, same as the seed phrase text itself. The phrase is
 * sensitive but displayed only on user action; never a copy affordance. */
const QrSeedDisplay = ({ phrase }: { phrase: string }) => {
  const [show, setShow] = useState(false);

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className='w-full rounded border border-border-soft py-2 text-xs font-mono text-fg-muted hover:text-fg-high transition-colors'
      >
        show QR for zigner backup
      </button>
    );
  }

  return (
    <div className='flex flex-col items-center gap-2'>
      <QrCode value={phrase} size={200} label='seed phrase QR for zigner backup' />
      <p className='text-label text-fg-muted/50 font-mono text-center'>
        scan with zigner camera to import seed. close this screen when done.
      </p>
      <button
        onClick={() => setShow(false)}
        className='text-label font-mono text-fg-muted hover:text-fg-high'
      >
        hide QR
      </button>
    </div>
  );
};
