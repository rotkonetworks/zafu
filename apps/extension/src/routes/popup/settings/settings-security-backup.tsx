import { useEffect, useState } from 'react';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { passwordSelector } from '../../../state/password';
import { terminateNetworkWorker, spawnNetworkWorker } from '../../../state/keyring/network-worker';
import { deleteZcashDatabases } from '../../../clear-cache-startup';
import { cn } from '@repo/ui/lib/utils';
import { SettingsScreen } from './settings-screen';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';

/**
 * Self-contained "Security & Backup" settings screen. Three controls, all of
 * which reuse existing state/actions - no crypto or cache logic is
 * reimplemented here:
 *
 *   1. recovery passphrase  - isPassword + getMnemonic (same flow as the
 *                             settings-wallets removal backup step)
 *   2. auto-lock            - localExtStorage 'autoLockMinutes' via useAutoLock
 *   3. clear cache          - deleteZcashDatabases (sync/scan stores only)
 */
export const SecurityBackup = () => {
  return (
    <SettingsScreen title='security & backup'>
      <div className='flex flex-col gap-5'>
        <RecoveryPhrase />
        <AutoLock />
        <ClearCache />
      </div>
    </SettingsScreen>
  );
};

/* ── 1. recovery passphrase ─────────────────────────────────────────── */

type PhraseStep = 'idle' | 'password' | 'revealed';

const RecoveryPhrase = () => {
  const activeVault = useStore(selectEffectiveKeyInfo);
  const { isPassword } = useStore(passwordSelector);
  const getMnemonic = useStore(selectGetMnemonic);

  const [step, setStep] = useState<PhraseStep>('idle');
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setStep('idle');
    setPassword('');
    setPhrase([]);
    setError(null);
    setBusy(false);
  };

  // Never leave the plaintext phrase (or a typed password) sitting in React
  // state after the card is torn down.
  useEffect(() => {
    return () => {
      setPhrase([]);
      setPassword('');
    };
  }, []);

  const reveal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeVault || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await isPassword(password);
    if (!ok) {
      setError('wrong password');
      setBusy(false);
      return;
    }
    try {
      const mnemonic = await getMnemonic(activeVault.id);
      setPhrase(mnemonic.split(' '));
      setPassword('');
      setStep('revealed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // An orphaned vault throws 'failed to decrypt vault' - its seed was
      // sealed under a previous password key and can no longer be read. Show a
      // clear message instead of crashing; the phrase physically is not
      // recoverable here.
      setPassword('');
      setError(
        msg.includes('failed to decrypt vault')
          ? "this wallet's recovery phrase can't be read from storage (the vault is unreadable). make sure you have it backed up elsewhere."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className='kicker mb-2'>recovery passphrase</p>
      <div className='flex flex-col gap-3 rounded-lg border border-border-soft bg-elev-1 p-3'>
        {!activeVault ? (
          <p className='text-label text-fg-muted'>no wallet selected.</p>
        ) : activeVault.type !== 'mnemonic' ? (
          // zigner and multisig vaults hold no seed phrase in this extension.
          <p className='text-label text-fg-muted'>
            "{activeVault.name}" has no recovery phrase here - it is a{' '}
            {activeVault.type === 'zigner-zafu' ? 'watch-only zigner' : 'multisig'} wallet. Back up
            the source device or run DKG again to restore it.
          </p>
        ) : (
          <>
            <p className='text-label text-fg-muted'>
              your {phrase.length || 12}-word phrase restores "{activeVault.name}" on any wallet.
              never share it - anyone with these words can spend your funds.
            </p>

            {step === 'idle' && (
              <button
                onClick={() => {
                  setStep('password');
                  setError(null);
                }}
                className='self-start rounded border border-border-soft bg-elev-2 px-2 py-0.5 text-label text-fg hover:text-fg-high hover:border-fg-muted transition-colors'
              >
                reveal recovery phrase
              </button>
            )}

            {step === 'password' && (
              <form onSubmit={e => void reveal(e)} className='flex flex-col gap-2'>
                <input
                  type='password'
                  value={password}
                  autoFocus
                  onChange={e => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  placeholder='password'
                  className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
                />
                {error && <span className='text-label text-red-400'>{error}</span>}
                <div className='flex gap-2'>
                  <button
                    type='button'
                    onClick={reset}
                    className='rounded border border-border-soft px-2 py-0.5 text-label text-fg-muted hover:text-fg-high transition-colors'
                  >
                    cancel
                  </button>
                  <button
                    type='submit'
                    disabled={!password || busy}
                    className='rounded border border-zigner-gold/40 bg-zigner-gold/10 px-2 py-0.5 text-label text-zigner-gold hover:bg-zigner-gold/20 transition-colors disabled:opacity-50'
                  >
                    {busy ? 'checking...' : 'reveal'}
                  </button>
                </div>
              </form>
            )}

            {step === 'revealed' && (
              <div className='flex flex-col gap-2'>
                <div className='select-all cursor-text rounded-lg bg-canvas border border-border-soft p-3 text-xs leading-relaxed break-words'>
                  {phrase.join(' ')}
                </div>
                <button
                  onClick={reset}
                  className='self-start rounded border border-border-soft px-2 py-0.5 text-label text-fg-muted hover:text-fg-high transition-colors'
                >
                  hide
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

/* ── 2. auto-lock ───────────────────────────────────────────────────── */

const AutoLock = () => {
  const { minutes, set } = useAutoLock();

  return (
    <div>
      <p className='kicker mb-2'>auto-lock</p>
      <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 p-3'>
        <p className='text-label text-fg-muted'>
          lock the wallet after this long with no activity.
        </p>
        <div className='flex flex-wrap gap-1.5'>
          {AUTO_LOCK_OPTIONS.map(o => (
            <button
              key={o.value}
              onClick={() => set(o.value)}
              className={cn(
                'rounded border px-2 py-0.5 text-label transition-colors',
                minutes === o.value
                  ? 'border-zigner-gold/50 bg-zigner-gold/10 text-zigner-gold'
                  : 'border-border-soft text-fg-muted hover:text-fg-high hover:border-fg-muted',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

/* ── 3. clear cache ─────────────────────────────────────────────────── */

type ClearStep = 'idle' | 'confirm' | 'clearing' | 'done';

const ClearCache = () => {
  const [step, setStep] = useState<ClearStep>('idle');

  const clear = async () => {
    setStep('clearing');
    try {
      // Same safe path the clear-cache screen uses: terminate the worker so the
      // in-memory commitment tree is dropped, clear ONLY the zcash sync/scan
      // object stores (deleteZcashDatabases preserves 'sent' history and the
      // 'wallets' registry, and touches no chrome.storage vaults/keys), then
      // respawn - sync restarts from the birthday. Applies to every zcash
      // wallet on this device.
      try {
        terminateNetworkWorker('zcash');
      } catch {}
      await deleteZcashDatabases();
      try {
        await spawnNetworkWorker('zcash');
      } catch {}
      setStep('done');
    } catch (e) {
      console.error('[security-backup] clear cache failed:', e);
      setStep('idle');
    }
  };

  return (
    <div>
      <p className='kicker mb-2'>clear cache</p>
      <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 p-3'>
        <p className='text-label text-fg-muted'>
          drops the zcash sync/scan cache and resyncs from the chain - use this to recover from a
          stuck or bad sync state. affects all zcash wallets on this device.
        </p>
        <p className='flex items-center gap-1.5 text-label text-rust'>
          <span className='i-ph-shield-check size-3.5' />
          keys, seeds, and send history are kept.
        </p>

        {step === 'done' ? (
          <p className='text-label text-fg-dim'>cache cleared - resyncing.</p>
        ) : step === 'confirm' || step === 'clearing' ? (
          <div className='flex gap-2'>
            <button
              disabled={step === 'clearing'}
              onClick={() => void clear()}
              className='rounded border border-hanko/40 bg-hanko/10 px-2 py-0.5 text-label text-hanko hover:bg-hanko/20 transition-colors disabled:opacity-50'
            >
              {step === 'clearing' ? 'clearing...' : 'yes, clear cache'}
            </button>
            {step === 'confirm' && (
              <button
                onClick={() => setStep('idle')}
                className='rounded border border-border-soft px-2 py-0.5 text-label text-fg-muted hover:text-fg-high transition-colors'
              >
                cancel
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={() => setStep('confirm')}
            className='self-start rounded border border-rust/30 bg-rust/5 px-2 py-0.5 text-label text-rust hover:bg-rust/15 transition-colors'
          >
            clear zcash cache
          </button>
        )}
      </div>
    </div>
  );
};
