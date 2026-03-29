import { useState, useCallback } from 'react';
import { CopyToClipboard } from '@repo/ui/components/ui/copy-to-clipboard';
import { PasswordInput } from '../../../shared/components/password-input';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { walletsSelector } from '../../../state/wallets';
import { SettingsScreen } from './settings-screen';

export const SettingsPassphrase = () => {
  const { isPassword } = useStore(passwordSelector);
  const { getSeedPhrase } = useStore(walletsSelector);

  const [password, setPassword] = useState('');
  const [enteredIncorrect, setEnteredIncorrect] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    void (async function () {
      if (await isPassword(password)) {
        setPassword('');
        setPhrase(await getSeedPhrase());
      } else {
        setEnteredIncorrect(true);
      }
    })();
  };

  return (
    <SettingsScreen title='recovery passphrase'>
      <div className='flex flex-col gap-4'>
        <p className='text-sm text-muted-foreground'>
          if you change browser or switch to another computer, you will need this recovery
          passphrase to access your accounts.
        </p>
        <p className='flex items-center gap-2 text-xs text-rust'>
          <span className='i-lucide-triangle-alert size-4' />
          don't share this phrase with anyone
        </p>

        {!phrase.length ? (
          <form onSubmit={submit} className='flex flex-col gap-3'>
            <PasswordInput
              passwordValue={password}
              label={<p className='text-sm text-muted-foreground'>password</p>}
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
            <button
              type='submit'
              className='w-full rounded-lg bg-primary py-2.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90'
            >
              confirm
            </button>
          </form>
        ) : (
          <div className='flex flex-col gap-3'>
            <div className='flex items-center gap-2 text-[10px] text-muted-foreground/60 font-mono'>
              <span className='h-2 w-2 rounded-full bg-yellow-400' />
              hot wallet — seed is in browser memory
            </div>
            <div
              className='select-all cursor-text rounded-lg bg-background border border-border/40 p-3 text-xs leading-relaxed break-words'
            >
              {phrase.join(' ')}
            </div>
            <CopyToClipboard
              text={phrase.join(' ')}
              label={<span className='text-xs text-muted-foreground'>copy to clipboard</span>}
              className='m-auto'
              isSuccessCopyText
            />

            {/* backup to zigner */}
            <div className='border-t border-border/40 pt-3 mt-1'>
              <p className='text-[10px] text-muted-foreground/60 font-mono mb-2'>
                scan with zigner to back up this seed on your air-gapped device.
                the seed goes INTO the air gap — never out.
              </p>
              <QrSeedDisplay phrase={phrase.join(' ')} />
            </div>
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};

/** QR code showing seed phrase for zigner backup import */
const QrSeedDisplay = ({ phrase }: { phrase: string }) => {
  const [show, setShow] = useState(false);

  const ref = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !phrase) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const QRCode = require('qrcode');
        // encode as simple text QR — zigner's camera can read and import
        // the phrase is sensitive but displayed only on user action
        QRCode.toCanvas(canvas, phrase, {
          width: 200,
          margin: 2,
          color: { dark: '#000', light: '#fff' },
          errorCorrectionLevel: 'L',
        });
      } catch { /* */ }
    },
    [phrase],
  );

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className='w-full rounded border border-border/40 py-2 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors'
      >
        show QR for zigner backup
      </button>
    );
  }

  return (
    <div className='flex flex-col items-center gap-2'>
      <div className='bg-white p-2 rounded'>
        <canvas ref={ref} />
      </div>
      <p className='text-[9px] text-muted-foreground/50 font-mono text-center'>
        scan with zigner camera to import seed.
        close this screen when done.
      </p>
      <button
        onClick={() => setShow(false)}
        className='text-[10px] font-mono text-muted-foreground hover:text-foreground'
      >
        hide QR
      </button>
    </div>
  );
};
