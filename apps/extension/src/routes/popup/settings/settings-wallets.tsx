import { TrashIcon } from '@radix-ui/react-icons';
import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useStore } from '../../../state';
import { keyRingSelector, type KeyInfo } from '../../../state/keyring';
import { passwordSelector } from '../../../state/password';
import { SettingsScreen } from './settings-screen';
import { deleteWalletInWorker, terminateNetworkWorker } from '../../../state/keyring/network-worker';

type RemovalStep = 'idle' | 'password' | 'backup' | 'confirm';

export const SettingsWallets = () => {
  const { keyInfos, deleteKeyRing, getMnemonic, renameKeyRing } = useStore(keyRingSelector);
  const { isPassword } = useStore(passwordSelector);

  const mnemonicVaults = keyInfos.filter(k => k.type === 'mnemonic');
  const zignerVaults = keyInfos.filter(k => k.type === 'zigner-zafu');

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingType, setRemovingType] = useState<'mnemonic' | 'zigner-zafu'>('mnemonic');
  const [step, setStep] = useState<RemovalStep>('idle');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);
  const [backupAcked, setBackupAcked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setRemovingId(null);
    setStep('idle');
    setPassword('');
    setPasswordError(false);
    setPhrase([]);
    setBackupAcked(false);
    setDeleting(false);
    setError(null);
  };

  const startRemoval = (vault: KeyInfo) => {
    reset();
    setRemovingId(vault.id);
    setRemovingType(vault.type as 'mnemonic' | 'zigner-zafu');
    setStep(vault.type === 'mnemonic' ? 'password' : 'confirm');
  };

  const verifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!removingId) return;
    const ok = await isPassword(password);
    if (!ok) { setPasswordError(true); return; }
    try {
      setPhrase((await getMnemonic(removingId)).split(' '));
      setPassword('');
      setStep('backup');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const executeRemoval = async () => {
    if (!removingId) return;
    setDeleting(true);
    setError(null);
    try {
      const isLast = keyInfos.length <= 1;
      await deleteKeyRing(removingId);
      try { await deleteWalletInWorker('zcash', removingId); } catch {}
      if (isLast) terminateNetworkWorker('zcash');
      reset();
      if (isLast) window.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const handleRename = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed) await renameKeyRing(id, trimmed).catch(() => {});
  };

  const removingVault = keyInfos.find(v => v.id === removingId);

  return (
    <SettingsScreen title='wallets'>
      <div className='flex flex-col gap-5'>

        {/* vault list */}
        {mnemonicVaults.length > 0 && (
          <VaultSection label='seed' vaults={mnemonicVaults}
            onRemove={startRemoval} onRename={handleRename}
            disabled={step !== 'idle'} />
        )}
        {zignerVaults.length > 0 && (
          <VaultSection label='zigner' vaults={zignerVaults}
            onRemove={startRemoval} onRename={handleRename}
            disabled={step !== 'idle'} />
        )}
        {keyInfos.length === 0 && (
          <p className='py-6 text-center text-sm text-muted-foreground'>no wallets</p>
        )}

        {/* add */}
        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          className='w-full border border-dashed border-border/50 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors duration-100'
        >
          + add wallet
        </button>

        {/* ── removal flow ── */}

        {/* step 1: password (mnemonic only) */}
        {removingVault && removingType === 'mnemonic' && step === 'password' && (
          <RemovalCard title={`remove "${removingVault.name}"`}>
            <p className='text-xs text-muted-foreground mb-3'>
              enter password to view recovery phrase.
            </p>
            <form onSubmit={e => void verifyPassword(e)} className='flex flex-col gap-2'>
              <input type='password' value={password} autoFocus
                onChange={e => { setPassword(e.target.value); setPasswordError(false); }}
                placeholder='password'
                className='w-full bg-background border border-border/40 px-3 py-2 text-sm focus:outline-none focus:border-primary/50' />
              {passwordError && <span className='text-xs text-red-400'>wrong password</span>}
              <div className='flex gap-2 mt-1'>
                <Btn onClick={reset}>cancel</Btn>
                <Btn submit destructive disabled={!password}>continue</Btn>
              </div>
            </form>
          </RemovalCard>
        )}

        {/* step 2: backup phrase (mnemonic only) */}
        {removingVault && removingType === 'mnemonic' && step === 'backup' && (
          <RemovalCard title='back up recovery phrase'>
            <div className='grid grid-cols-3 gap-1.5 bg-background border border-border/40 p-3 mb-3'>
              {phrase.map((w, i) => (
                <div key={i} className='flex text-xs'>
                  <span className='w-5 text-right text-muted-foreground mr-1'>{i + 1}.</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
            <label className='flex items-start gap-2 mb-3 cursor-pointer select-none'>
              <input type='checkbox' checked={backupAcked}
                onChange={e => setBackupAcked(e.target.checked)} className='mt-0.5' />
              <span className='text-xs text-muted-foreground'>i have backed up my phrase</span>
            </label>
            <div className='flex gap-2'>
              <Btn onClick={reset}>cancel</Btn>
              <Btn destructive disabled={!backupAcked}
                onClick={() => setStep('confirm')}>remove</Btn>
            </div>
          </RemovalCard>
        )}

        {/* step 3: final confirm (both types) */}
        {removingVault && step === 'confirm' && (
          <RemovalCard title='confirm removal'>
            <p className='text-xs text-muted-foreground mb-3'>
              "{removingVault.name}" will be permanently removed.
              {removingType === 'zigner-zafu' && ' re-import from zigner anytime.'}
            </p>
            {error && <p className='text-xs text-red-400 mb-2'>{error}</p>}
            <div className='flex gap-2'>
              <Btn onClick={reset} disabled={deleting}>cancel</Btn>
              <Btn destructive disabled={deleting}
                onClick={() => void executeRemoval()}>
                {deleting ? 'removing...' : 'remove'}
              </Btn>
            </div>
          </RemovalCard>
        )}

        {error && step === 'idle' && (
          <p className='text-xs text-red-400'>{error}</p>
        )}
      </div>
    </SettingsScreen>
  );
};

/* ── vault section ── */

const VaultSection = ({ label, vaults, onRemove, onRename, disabled }: {
  label: string;
  vaults: KeyInfo[];
  onRemove: (v: KeyInfo) => void;
  onRename: (id: string, name: string) => void;
  disabled: boolean;
}) => (
  <div>
    <div className='text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5'>{label}</div>
    <div className='flex flex-col divide-y divide-border/20 border border-border/40 bg-card'>
      {vaults.map(v => (
        <VaultRow key={v.id} vault={v}
          onRemove={() => onRemove(v)}
          onRename={name => onRename(v.id, name)}
          disabled={disabled} />
      ))}
    </div>
  </div>
);

/* ── vault row with inline rename ── */

const VaultRow = ({ vault, onRemove, onRename, disabled }: {
  vault: KeyInfo;
  onRemove: () => void;
  onRename: (name: string) => void;
  disabled: boolean;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(vault.name);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== vault.name) onRename(t);
    else setDraft(vault.name);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { setDraft(vault.name); setEditing(false); }
  };

  return (
    <div className='group flex items-center gap-2 px-3 py-2.5'>
      <div className='flex-1 min-w-0'>
        {editing ? (
          <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
            onBlur={commit} onKeyDown={onKey} autoFocus
            className='w-full text-sm bg-transparent border-b border-primary/50 outline-none' />
        ) : (
          <button onClick={() => { setDraft(vault.name); setEditing(true); }}
            className='text-sm text-left truncate w-full hover:text-primary transition-colors duration-75'>
            {vault.name}
          </button>
        )}
      </div>
      <button onClick={onRemove} disabled={disabled}
        className='p-1 text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-400 transition-colors duration-75 disabled:opacity-30'>
        <TrashIcon className='size-3.5' />
      </button>
    </div>
  );
};

/* ── shared ui ── */

const RemovalCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className='rounded-lg border border-red-500/20 bg-card p-4'>
    <div className='text-sm font-medium text-red-400 mb-2'>{title}</div>
    {children}
  </div>
);

const Btn = ({ children, onClick, submit, destructive, disabled }: {
  children: React.ReactNode;
  onClick?: () => void;
  submit?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) => (
  <button type={submit ? 'submit' : 'button'} onClick={onClick} disabled={disabled}
    className={`flex-1 py-2 text-xs transition-colors duration-100 disabled:opacity-30 ${
      destructive
        ? 'bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25'
        : 'border border-border/40 hover:bg-muted'
    }`}>
    {children}
  </button>
);
