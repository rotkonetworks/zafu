import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../../../state';
import { keyRingSelector, type KeyInfo, type ZignerZafuImport } from '../../../state/keyring';
import { walletsSelector } from '../../../state/wallets';
import { zignerConnectSelector } from '../../../state/zigner';
import { passwordSelector } from '../../../state/password';
import { SettingsScreen } from './settings-screen';
import { terminateNetworkWorker } from '../../../state/keyring/network-worker';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';

type RemovalStep = 'idle' | 'password' | 'backup' | 'confirm';

/** network badges for a vault */
const networkBadge = (network: string) => {
  const colors: Record<string, string> = {
    penumbra: 'bg-purple-500/15 text-purple-400',
    zcash: 'bg-yellow-500/15 text-yellow-400',
    cosmos: 'bg-blue-500/15 text-blue-400',
    polkadot: 'bg-pink-500/15 text-pink-400',
    kusama: 'bg-pink-500/15 text-pink-400',
  };
  return (
    <span key={network} className={cn('text-[10px] px-1.5 py-0.5 rounded', colors[network] ?? 'bg-muted text-muted-foreground')}>
      {network}
    </span>
  );
};

export const SettingsWallets = () => {
  const location = useLocation();
  const autoScan = (location.state as { autoScan?: boolean } | null)?.autoScan;

  const { keyInfos, deleteKeyRing, getMnemonic, renameKeyRing, addZignerUnencrypted } = useStore(keyRingSelector);
  const { isPassword } = useStore(passwordSelector);
  const {
    all: penumbraWallets,
    zcashWallets,
  } = useStore(walletsSelector);
  const {
    scanState,
    walletLabel,
    walletImport,
    zcashWalletImport,
    parsedPolkadotExport,
    parsedCosmosExport,
    detectedNetwork,
    errorMessage,
    processQrData,
    setWalletLabel,
    setScanState,
    setError,
    clearZignerState,
  } = useStore(zignerConnectSelector);

  // -- removal state --
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingType, setRemovingType] = useState<string>('mnemonic');
  const [step, setStep] = useState<RemovalStep>('idle');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);
  const [backupAcked, setBackupAcked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setStateError] = useState<string | null>(null);

  // -- add wallet state --
  const [scanning, setScanning] = useState(false);
  const [addSuccess, setAddSuccess] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // hidden paste mode — activated by tapping info box 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualInputRef = useRef(false);

  useEffect(() => {
    return () => { clearZignerState(); };
  }, [clearZignerState]);

  // auto-start scanner when navigated with autoScan
  useEffect(() => {
    if (autoScan && !scanning && scanState === 'idle') {
      setScanning(true);
    }
  }, [autoScan]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- removal logic --
  const resetRemoval = () => {
    setRemovingId(null);
    setStep('idle');
    setPassword('');
    setPasswordError(false);
    setPhrase([]);
    setBackupAcked(false);
    setDeleting(false);
    setStateError(null);
  };

  const startRemoval = (vault: KeyInfo) => {
    resetRemoval();
    setRemovingId(vault.id);
    setRemovingType(vault.type);
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
      setStateError(err instanceof Error ? err.message : String(err));
    }
  };

  const executeRemoval = async () => {
    if (!removingId) return;
    setDeleting(true);
    setStateError(null);
    try {
      const isLast = keyInfos.length <= 1;
      await deleteKeyRing(removingId);
      if (isLast) terminateNetworkWorker('zcash');
      resetRemoval();
      if (isLast) window.close();
    } catch (err) {
      setStateError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const handleRename = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed) await renameKeyRing(id, trimmed).catch(() => {});
  };

  // -- add wallet logic --
  const handleQrScan = useCallback((data: string) => {
    setScanning(false);
    processQrData(data);
  }, [processQrData]);

  const handleSecretTap = () => {
    clickCountRef.current += 1;
    if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    clickTimeoutRef.current = setTimeout(() => { clickCountRef.current = 0; }, 3000);
    if (clickCountRef.current >= 10) {
      manualInputRef.current = true;
      setScanState('idle');
      clickCountRef.current = 0;
    }
  };

  const handleAddWallet = async () => {
    if (!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) {
      setError('please scan a qr code first');
      return;
    }
    try {
      setIsAdding(true);
      if (detectedNetwork === 'penumbra' && walletImport) {
        // route through vault system so wallet gets vaultId and shows in wallet list
        const fvkBytes = walletImport.fullViewingKey.inner;
        const zignerData: ZignerZafuImport = {
          fullViewingKey: btoa(String.fromCharCode(...fvkBytes)),
          accountIndex: walletImport.accountIndex,
          deviceId: `penumbra-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || walletImport.label || 'zigner penumbra');
      } else if (detectedNetwork === 'zcash' && zcashWalletImport) {
        // route through vault system so wallet gets vaultId and shows in wallet list
        const viewingKey = zcashWalletImport.ufvk
          || (zcashWalletImport.orchardFvk ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk)) : undefined);
        const zignerData: ZignerZafuImport = {
          viewingKey,
          accountIndex: zcashWalletImport.accountIndex,
          deviceId: `zcash-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || zcashWalletImport.label || 'zigner zcash');
      } else if (detectedNetwork === 'cosmos' && parsedCosmosExport) {
        const zignerData: ZignerZafuImport = {
          cosmosAddresses: parsedCosmosExport.addresses,
          publicKey: parsedCosmosExport.publicKey || undefined,
          accountIndex: parsedCosmosExport.accountIndex,
          deviceId: `cosmos-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner cosmos');
      } else if (detectedNetwork === 'polkadot' && parsedPolkadotExport) {
        const zignerData: ZignerZafuImport = {
          polkadotSs58: parsedPolkadotExport.address,
          polkadotGenesisHash: parsedPolkadotExport.genesisHash,
          accountIndex: 0,
          deviceId: `polkadot-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner polkadot');
      }
      setAddSuccess(true);
      clearZignerState();
      manualInputRef.current = false;
      setTimeout(() => setAddSuccess(false), 3000);
    } catch (cause) {
      setError(`failed to add wallet: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setIsAdding(false);
    }
  };

  const resetAdd = () => {
    clearZignerState();
    manualInputRef.current = false;
  };

  const removingVault = keyInfos.find(v => v.id === removingId);
  const showManualInput = manualInputRef.current && scanState !== 'scanned';
  const showScannedState = scanState === 'scanned' && (walletImport || zcashWalletImport || parsedPolkadotExport || parsedCosmosExport);
  const showInitialState = scanState === 'idle' && !showManualInput;

  return (
    <>
    {scanning && (
      <QrScanner
        onScan={handleQrScan}
        onError={(err) => { setError(err); setScanning(false); }}
        onClose={() => setScanning(false)}
        title='scan zigner QR'
        description='point camera at your zigner FVK QR code' />
    )}
    <SettingsScreen title='wallets'>
      <div className='flex flex-col gap-5'>

        {/* ── wallet list ── */}

        {keyInfos.length > 0 ? (
          <div className='flex flex-col divide-y divide-border/40 rounded-lg border border-border/40 bg-card'>
            {keyInfos.map(v => {
              const networks: string[] = [];
              if (penumbraWallets.some(w => w.vaultId === v.id)) networks.push('penumbra');
              if (zcashWallets.some(w => w.vaultId === v.id)) networks.push('zcash');
              if (v.insensitive['cosmosAddresses']) networks.push('cosmos');
              if (v.insensitive['polkadotSs58']) networks.push('polkadot');
              // seed wallets derive keys for all networks
              if (v.type === 'mnemonic') {
                if (!networks.includes('zcash')) networks.push('zcash');
                if (!networks.includes('penumbra')) networks.push('penumbra');
              }
              // frost-multisig vaults support zcash
              if (v.type === 'frost-multisig' && !networks.includes('zcash')) {
                networks.push('zcash');
              }

              // multisig detail link
              const multisigWallet = v.type === 'frost-multisig'
                ? zcashWallets.find(w => w.vaultId === v.id && w.multisig)
                : undefined;

              return (
                <VaultRow key={v.id} vault={v} networks={networks}
                  multisigWallet={multisigWallet}
                  onRemove={() => startRemoval(v)}
                  onRename={name => handleRename(v.id, name)}
                  disabled={step !== 'idle'} />
              );
            })}
          </div>
        ) : (
          <p className='py-12 text-center text-sm text-muted-foreground'>no wallets</p>
        )}

        {/* ── removal flow ── */}

        {removingVault && removingType === 'mnemonic' && step === 'password' && (
          <RemovalCard title={`remove "${removingVault.name}"`}>
            <p className='text-xs text-muted-foreground mb-3'>
              enter password to view recovery phrase.
            </p>
            <form onSubmit={e => void verifyPassword(e)} className='flex flex-col gap-2'>
              <input type='password' value={password} autoFocus
                onChange={e => { setPassword(e.target.value); setPasswordError(false); }}
                placeholder='password'
                className='w-full bg-input border border-border/40 px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:border-primary' />
              {passwordError && <span className='text-xs text-red-400'>wrong password</span>}
              <div className='flex gap-2 mt-1'>
                <Btn onClick={resetRemoval}>cancel</Btn>
                <Btn submit destructive disabled={!password}>continue</Btn>
              </div>
            </form>
          </RemovalCard>
        )}

        {removingVault && removingType === 'mnemonic' && step === 'backup' && (
          <RemovalCard title='back up recovery phrase'>
            <div className='grid grid-cols-3 gap-1.5 rounded-lg bg-background border border-border/40 p-3 mb-3'>
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
              <Btn onClick={resetRemoval}>cancel</Btn>
              <Btn destructive disabled={!backupAcked}
                onClick={() => setStep('confirm')}>remove</Btn>
            </div>
          </RemovalCard>
        )}

        {removingVault && step === 'confirm' && (
          <RemovalCard title='confirm removal'>
            <p className='text-xs text-muted-foreground mb-3'>
              "{removingVault.name}" will be permanently removed.
              {removingType === 'zigner-zafu' && ' re-import from zigner anytime.'}
              {removingType === 'frost-multisig' && ' you would need to run DKG again.'}
            </p>
            {error && <p className='text-xs text-red-400 mb-2'>{error}</p>}
            <div className='flex gap-2'>
              <Btn onClick={resetRemoval} disabled={deleting}>cancel</Btn>
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

        {/* ── add wallet ── */}

        <div className='border-t border-border/40 pt-4'>
          {/* zigner info box — tap 10x for dev paste mode */}
          <div className='rounded-lg border border-border/40 bg-card p-3 mb-3' onClick={handleSecretTap}>
            <p className='text-xs text-muted-foreground'>
              zafu zigner keeps spending keys offline. transactions require QR code signing with your device.
            </p>
            <a href='https://zigner.rotko.net' target='_blank' rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-xs text-primary hover:underline mt-2'>
              <span className='i-lucide-external-link h-3 w-3' />
              download zafu zigner
            </a>
          </div>

          {addSuccess && (
            <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 mb-3 text-xs text-green-400'>
              wallet added successfully
            </div>
          )}

          {/* scanned state */}
          {showScannedState && (
            <div className='flex flex-col gap-3'>
              <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3'>
                <div className='flex items-center gap-2'>
                  <p className='text-xs text-green-400'>qr code scanned</p>
                  <span className='text-[10px] px-1 rounded-md bg-muted text-muted-foreground'>{detectedNetwork}</span>
                </div>
                <p className='text-[10px] text-muted-foreground mt-1 font-mono'>
                  {parsedCosmosExport ? (
                    <>{parsedCosmosExport.addresses.map(a => a.address.slice(0, 10)).join(', ')}...</>
                  ) : parsedPolkadotExport ? (
                    <>{parsedPolkadotExport.address.slice(0, 8)}...{parsedPolkadotExport.address.slice(-6)}</>
                  ) : (
                    <>
                      account #{walletImport?.accountIndex ?? zcashWalletImport?.accountIndex ?? 0}
                      {zcashWalletImport && (
                        <span className='ml-2'>{zcashWalletImport.mainnet ? 'mainnet' : 'testnet'}</span>
                      )}
                    </>
                  )}
                </p>
              </div>
              <Input placeholder='wallet label (optional)' value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)} />
              {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}
              <div className='flex gap-2'>
                <Btn onClick={resetAdd}>cancel</Btn>
                <Btn primary disabled={isAdding} onClick={() => void handleAddWallet()}>
                  {isAdding ? 'adding...' : 'add wallet'}
                </Btn>
              </div>
            </div>
          )}

          {/* manual paste mode (dev) */}
          {showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-[10px] text-muted-foreground'>developer mode: paste QR hex data</p>
              <Input placeholder='paste QR code hex (530301...)'
                onChange={e => { if (e.target.value.trim()) processQrData(e.target.value); }}
                className='font-mono text-xs' />
              <Input placeholder='wallet label (optional)' value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)} />
              {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}
              <div className='flex gap-2'>
                <Btn onClick={resetAdd}>cancel</Btn>
                <Btn primary disabled={(!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) || isAdding}
                  onClick={() => void handleAddWallet()}>
                  {isAdding ? 'adding...' : 'add wallet'}
                </Btn>
              </div>
            </div>
          )}

          {/* initial: scan button + import seed */}
          {showInitialState && (
            <div className='flex flex-col gap-2'>
              <button onClick={() => setScanning(true)}
                className='w-full flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-primary hover:bg-primary/10 transition-colors'>
                <span className='i-lucide-scan-line size-4' />
                scan zigner QR
              </button>
              <button onClick={() => chrome.runtime.openOptionsPage()}
                className='w-full rounded-lg border border-dashed border-border/40 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:border-border/60 transition-colors'>
                + import seed phrase
              </button>
              {errorMessage && <p className='text-xs text-red-400 text-center'>{errorMessage}</p>}
            </div>
          )}

          {/* error state */}
          {scanState === 'error' && !showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-xs text-red-400'>{errorMessage}</p>
              <Btn onClick={resetAdd}>try again</Btn>
            </div>
          )}
        </div>

      </div>
    </SettingsScreen>
    </>
  );
};

/* ── vault row with inline rename + network badges ── */

const VaultRow = ({ vault, networks, multisigWallet, onRemove, onRename, disabled }: {
  vault: KeyInfo;
  networks: string[];
  multisigWallet?: import('../../../state/wallets').ZcashWalletJson;
  onRemove: () => void;
  onRename: (name: string) => void;
  disabled: boolean;
}) => {
  const navigate = usePopupNav();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(vault.name);
  const ref = useRef<HTMLInputElement>(null);
  const hasZcash = networks.includes('zcash');

  // zcash birthday height per wallet
  const [birthday, setBirthday] = useState<string>('');
  const birthdayKey = `zcashBirthday_${vault.id}`;

  useEffect(() => {
    if (!hasZcash) return;
    chrome.storage.local.get(birthdayKey).then(r => {
      const v = r[birthdayKey];
      if (v !== undefined) setBirthday(String(v));
    });
  }, [hasZcash, birthdayKey]);

  const saveBirthday = () => {
    const num = parseInt(birthday, 10);
    if (!isNaN(num) && num >= ZCASH_ORCHARD_ACTIVATION) {
      void chrome.storage.local.set({ [birthdayKey]: num });
    } else if (!isNaN(num) && num > 0 && num < ZCASH_ORCHARD_ACTIVATION) {
      // clamp to orchard activation — no point scanning earlier
      setBirthday(String(ZCASH_ORCHARD_ACTIVATION));
      void chrome.storage.local.set({ [birthdayKey]: ZCASH_ORCHARD_ACTIVATION });
    } else if (birthday === '') {
      void chrome.storage.local.remove(birthdayKey);
    }
  };

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
    <div className='group px-3 py-2.5'>
      <div className='flex items-center gap-2'>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-1.5'>
            {editing ? (
              <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
                onBlur={commit} onKeyDown={onKey} autoFocus
                className='w-full text-sm bg-transparent border-b border-primary/50 outline-none' />
            ) : (
              <button onClick={() => { setDraft(vault.name); setEditing(true); }}
                className='text-sm text-left truncate hover:text-primary transition-colors'>
                {vault.name}
              </button>
            )}
          </div>
          {networks.length > 0 && (
            <div className='flex gap-1 mt-1'>
              {networks.map(networkBadge)}
            </div>
          )}
        </div>
        <button onClick={onRemove} disabled={disabled}
          className='p-1 text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-400 transition-colors disabled:opacity-50'>
          <span className='i-lucide-trash-2 size-3.5' />
        </button>
      </div>

      {/* zcash start block */}
      {hasZcash && (
        <div className='mt-2'>
          <div className='flex items-center gap-2'>
            <span className='text-[10px] text-muted-foreground whitespace-nowrap'>sync from</span>
            <input
              type='number' min={ZCASH_ORCHARD_ACTIVATION} step='1000' value={birthday}
              onChange={e => setBirthday(e.target.value)}
              onBlur={saveBirthday}
              onKeyDown={e => e.key === 'Enter' && saveBirthday()}
              placeholder='auto'
              className='w-24 bg-input border border-border/40 px-2 py-1 text-[10px] font-mono rounded focus:outline-none focus:border-primary/50'
            />
          </div>
          <p className='text-[9px] text-muted-foreground/60 mt-0.5'>orchard only — sapling/sprout not supported</p>
        </div>
      )}

      {vault.type === 'zigner-zafu' && hasZcash && (
        <button
          onClick={() => navigate(PopupPath.NOTE_SYNC)}
          className='flex items-center gap-1.5 mt-2 text-[10px] text-muted-foreground hover:text-foreground'
        >
          <span className='i-lucide-qr-code size-3' />
          sync balance to zigner
        </button>
      )}

      {multisigWallet && (
        <div className='flex items-center gap-2 mt-2'>
          <span className='text-[10px] text-muted-foreground'>
            {String(vault.insensitive['threshold'])}/{String(vault.insensitive['maxSigners'])}
          </span>
          <button
            onClick={() => navigate(`${PopupPath.SETTINGS_MULTISIG}?id=${multisigWallet.id}` as PopupPath)}
            className='text-[10px] text-muted-foreground hover:text-foreground'
          >
            edit
          </button>
          <button
            onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
            className='text-[10px] text-primary'
          >
            co-sign
          </button>
        </div>
      )}
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

const Btn = ({ children, onClick, submit, destructive, primary, disabled }: {
  children: React.ReactNode;
  onClick?: () => void;
  submit?: boolean;
  destructive?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) => (
  <button type={submit ? 'submit' : 'button'} onClick={onClick} disabled={disabled}
    className={cn(
      'flex-1 rounded-lg py-2 text-xs transition-colors duration-100 disabled:opacity-50',
      destructive && 'bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25',
      primary && 'bg-primary/15 text-primary border border-primary/25 hover:bg-primary/25',
      !destructive && !primary && 'border border-border/40 hover:bg-muted/50',
    )}>
    {children}
  </button>
);
