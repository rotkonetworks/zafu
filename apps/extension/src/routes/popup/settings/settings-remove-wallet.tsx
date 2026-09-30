import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import { keyRingSelector } from '../../../state/keyring';
import { passwordSelector } from '../../../state/password';
import { terminateNetworkWorker } from '../../../state/keyring/network-worker';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { Button } from '@repo/ui/components/ui/button';
import { PasswordInput } from '../../../shared/components/password-input';
import { cn } from '@repo/ui/lib/utils';

type Step = 'what' | 'confirm' | 'gone';

/**
 * Remove wallet (SetRemove.dc.html): what leaves this computer / what stays
 * safe, a tick affirming the phrase is held (mnemonic vaults only), then a
 * password and the red delete button. Calls the existing `deleteKeyRing` -
 * the removal cleanup itself is unchanged, this only restyles the flow onto
 * the primitives and asks for the password once, up front, for every vault
 * type (the old flow skipped the password for non-mnemonic vaults).
 */
export const SettingsRemoveWallet = () => {
  const navigate = usePopupNav();
  const [searchParams] = useSearchParams();
  const id = searchParams.get('id') ?? '';

  const { keyInfos, deleteKeyRing } = useStore(keyRingSelector);
  const { isPassword } = useStore(passwordSelector);
  const vault = keyInfos.find(v => v.id === id);
  const needsPhraseTick = vault?.type === 'mnemonic';

  const [step, setStep] = useState<Step>('what');
  const [ticked, setTicked] = useState(false);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!vault) {
    return (
      <SettingsScreen title='remove wallet' backPath={PopupPath.SETTINGS_WALLETS}>
        <p className='text-sm text-fg-muted'>this wallet is already gone.</p>
      </SettingsScreen>
    );
  }

  const ready = step === 'confirm' || !needsPhraseTick || ticked;

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      if (!(await isPassword(password))) {
        setWrong(true);
        return;
      }
      const isLast = keyInfos.length <= 1;
      await deleteKeyRing(vault.id);
      if (isLast) {
        terminateNetworkWorker('zcash');
      }
      setStep('gone');
      if (isLast) {
        window.close();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SettingsScreen title={`remove ${vault.name}`} backPath={PopupPath.SETTINGS_WALLETS}>
      <div className='flex flex-col gap-4'>
        {step === 'what' && (
          <div className='flex flex-col gap-4'>
            <div>
              <p className='kicker mb-2'>leaves this computer</p>
              <ul className='flex flex-col gap-2 border border-border-soft bg-elev-1 p-3'>
                <FactRow tone='bg-hanko' text={`keys for ${vault.name}`} meta='on this computer' />
                <FactRow
                  tone='bg-hanko'
                  text='saved history and notes'
                  meta='rebuilt if you add it back'
                />
              </ul>
              {keyInfos.length <= 1 && (
                <p className='mt-2 text-label text-warn'>
                  this is your last wallet - removing it wipes all wallet data from this extension.
                </p>
              )}
            </div>
            <div>
              <p className='kicker mb-2'>stays safe</p>
              <div className='border border-border-soft bg-elev-1 p-3'>
                <FactRow tone='bg-green-400' text='what is on chain' meta='the phrase brings it back' />
              </div>
            </div>

            {needsPhraseTick && (
              <button
                type='button'
                role='checkbox'
                aria-checked={ticked}
                onClick={() => setTicked(v => !v)}
                className={cn(
                  'flex min-h-[52px] items-center gap-3 border px-3.5 text-left transition-colors',
                  ticked ? 'border-zigner-gold bg-zigner-gold/10' : 'border-border-soft',
                )}
              >
                <span
                  className={cn(
                    'flex size-[18px] shrink-0 items-center justify-center border',
                    ticked ? 'border-zigner-gold bg-zigner-gold' : 'border-fg-dim',
                  )}
                >
                  {ticked && <span className='i-ph-check size-3 text-zigner-gold-foreground' />}
                </span>
                <span className='text-data text-fg-high lowercase'>
                  i have the recovery phrase for {vault.name}
                </span>
              </button>
            )}

            {needsPhraseTick && (
              <button
                type='button'
                onClick={() => navigate(PopupPath.SETTINGS_RECOVERY_PASSPHRASE)}
                className='self-start text-label text-fg-muted underline-offset-2 hover:underline'
              >
                show it once more first
              </button>
            )}
          </div>
        )}

        {step === 'confirm' && (
          <div className='flex flex-col gap-3'>
            <p className='text-sm text-fg'>
              one last step. please enter your password to remove {vault.name}.
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
                  issue: 'wrong password',
                  checkFn: (txt: string) => Boolean(txt) && wrong,
                },
              ]}
              autoFocus
            />
            {error && <p className='text-xs text-hanko-light'>{error}</p>}
          </div>
        )}

        {step === 'gone' && (
          <div className='flex grow flex-col items-center gap-4 pt-10 text-center'>
            <span className='i-ph-check-circle size-16 text-fg-muted' aria-hidden='true' />
            <p className='text-title text-fg-high'>
              {vault.name} has left this computer
            </p>
            <p className='max-w-[280px] text-sm text-fg-muted'>
              what was on chain is still on chain. your recovery phrase brings it back whenever you
              like.
            </p>
          </div>
        )}
      </div>

      {step !== 'gone' ? (
        <div className='mt-4 flex gap-2 border-t border-border-soft pt-4'>
          <Button
            variant='secondary'
            size='md'
            className='w-28'
            onClick={() => (step === 'confirm' ? setStep('what') : navigate(PopupPath.SETTINGS_WALLETS))}
          >
            not now
          </Button>
          <Button
            variant='danger'
            size='md'
            className='flex-1'
            disabled={!ready || deleting}
            onClick={() => (step === 'what' ? setStep('confirm') : void remove())}
          >
            {step === 'confirm' ? (deleting ? 'removing...' : `remove ${vault.name}`) : 'continue'}
          </Button>
        </div>
      ) : (
        <div className='mt-4 border-t border-border-soft pt-4'>
          <Button
            variant='secondary'
            size='md'
            className='w-full'
            onClick={() => navigate(PopupPath.SETTINGS)}
          >
            back to settings
          </Button>
        </div>
      )}
    </SettingsScreen>
  );
};

const FactRow = ({ tone, text, meta }: { tone: string; text: string; meta: string }) => (
  <li className='flex items-center gap-3'>
    <span className={cn('size-1.5 shrink-0', tone)} />
    <span className='flex-1 text-sm text-fg-high'>{text}</span>
    <span className='text-label text-fg-muted'>{meta}</span>
  </li>
);
