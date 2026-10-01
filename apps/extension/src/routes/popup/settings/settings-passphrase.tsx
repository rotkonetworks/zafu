import { useEffect, useState } from 'react';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { QrCode } from '../../../components/qr-code';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { localExtStorage } from '@repo/storage-chrome/local';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';

/** blurred words re-cover after this long, so a phrase left open on screen
 *  does not stay legible past a glance (SetPhrase.dc.html). */
const RECOVER_AFTER_MS = 60_000;

export const SettingsPassphrase = () => {
  const navigate = usePopupNav();
  const { isPassword } = useStore(passwordSelector);
  const getMnemonic = useStore(selectGetMnemonic);
  const vault = useStore(selectEffectiveKeyInfo);

  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

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
    if (!vault || !password) {
      return;
    }
    setError(null);
    void (async function () {
      try {
        if (await isPassword(password)) {
          setPassword('');
          setPhrase((await getMnemonic(vault.id)).trim().split(/\s+/));
          // revealing the phrase counts as possessing it - clear the home nudge
          void localExtStorage.set('seedPhraseBackedUp', true);
        } else {
          setWrong(true);
        }
      } catch {
        setError('something broke on our side, not yours. nothing was lost.');
      }
    })();
  };

  const shown = phrase.length > 0;
  const hot = vault?.type === 'mnemonic';
  const note = wrong ? "that doesn't match · please try again, slowly" : error;

  return (
    <SettingsScreen
      title='recovery phrase'
      category='security'
      meta={vault?.name.toLowerCase()}
      backPath={PopupPath.SETTINGS_SECURITY}
    >
      <form id='phrase' onSubmit={submit} className='flex grow flex-col gap-3.5 pt-0.5'>
        {!hot ? (
          <p className='text-[13px]/[1.6] text-fg'>
            the phrase for {vault?.name ?? 'this wallet'} lives on its own device.
          </p>
        ) : !shown ? (
          <>
            <p className='text-[13px]/[1.6] text-fg'>
              anyone who sees these words can take the wallet. please make sure you are alone.
            </p>
            <label className='flex flex-col gap-1.5'>
              <span className='text-label text-fg-muted'>password</span>
              <Input
                type='password'
                autoComplete='current-password'
                variant={wrong ? 'error' : 'default'}
                value={password}
                autoFocus
                onChange={e => {
                  setPassword(e.target.value);
                  setWrong(false);
                }}
              />
              <span className='h-4 text-[11px] text-hanko'>{note}</span>
            </label>
          </>
        ) : (
          <>
            <PhraseGrid words={phrase} revealed={revealed} onReveal={() => setRevealed(true)} />
            <div className='flex gap-2'>
              <Button
                type='button'
                variant='secondary'
                className='flex-1'
                onClick={() => setRevealed(v => !v)}
              >
                {revealed ? 'hide' : 'show'}
              </Button>
              {/* the seed goes INTO the air gap, never out */}
              <Button
                type='button'
                variant='secondary'
                className='flex-1'
                onClick={() => setQrOpen(true)}
              >
                back up to zigner
              </Button>
            </div>
            <span className='h-4 text-[11px] text-fg-muted'>
              {revealed ? 'zafu covers them again after a minute' : 'blurred until you ask'}
            </span>
          </>
        )}
      </form>

      <div className='-mx-4 mt-4 flex gap-2 border-t border-border-soft px-4 pt-3'>
        {hot && !shown ? (
          <>
            <Button
              variant='secondary'
              className='w-[110px]'
              onClick={() => navigate(PopupPath.SETTINGS_SECURITY)}
            >
              not now
            </Button>
            <Button type='submit' form='phrase' className='flex-1' disabled={!password}>
              continue
            </Button>
          </>
        ) : (
          <Button className='flex-1' onClick={() => navigate(PopupPath.SETTINGS_SECURITY)}>
            done
          </Button>
        )}
      </div>

      <Sheet open={qrOpen} onOpenChange={setQrOpen} title='back up to zigner'>
        <div className='flex justify-center'>
          <QrCode value={phrase.join(' ')} size={200} label='seed phrase QR for zigner backup' />
        </div>
      </Sheet>
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
