import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  keyRingSelector,
  selectEnabledNetworks,
  type KeyInfo,
  type ZignerZafuImport,
} from '../../../state/keyring';
import { walletsSelector } from '../../../state/wallets';
import { zignerConnectSelector } from '../../../state/zigner';
import { passwordSelector } from '../../../state/password';
import { SettingsScreen } from './settings-screen';
import { terminateNetworkWorker } from '../../../state/keyring/network-worker';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { CustodyBadge } from '../../../components/custody-badge';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { ZCASH_ORCHARD_ACTIVATION, isLaunched } from '../../../config/networks';
import {
  describeZcashHeight,
  dateToBlock,
  blockToDate,
  formatDateInput,
} from '../../../utils/zcash-blocks';

// One shared state machine drives BOTH remove and export-recovery-phrase, so
// only one wallet's secret is ever in React state at a time (mutual exclusion)
// and the "failed to decrypt vault" handling is shared. 'reveal' is the
// export-only terminal step (show phrase, no backup-ack, no delete).
type RemovalStep = 'idle' | 'password' | 'backup' | 'confirm' | 'reveal';
type ActionKind = 'remove' | 'export';

/** network badges for a vault */
const networkBadge = (network: string) => {
  const colors: Record<string, string> = {
    penumbra: 'bg-teal-400/15 text-teal-300',
    zcash: 'bg-yellow-500/15 text-yellow-400',
    cosmos: 'bg-blue-500/15 text-blue-400',
    polkadot: 'bg-pink-500/15 text-pink-400',
    kusama: 'bg-pink-500/15 text-pink-400',
  };
  return (
    <span
      key={network}
      className={cn(
        'text-label px-1.5 py-0.5 rounded',
        colors[network] ?? 'bg-elev-2 text-fg-muted',
      )}
    >
      {network}
    </span>
  );
};

export const SettingsWallets = ({
  title = 'wallets',
  appendSlot,
}: {
  /** Screen title - overridden to "wallets & networks" when the networks
   *  section is composed into this screen (settings IA merge). */
  title?: string;
  /** Extra content rendered INSIDE this screen's scroll column, after the
   *  wallet/add sections - used to fold the networks section into one tab so it
   *  shares the same header/back/scroll chrome instead of hanging off a sibling
   *  block below a full-height screen. */
  appendSlot?: React.ReactNode;
} = {}) => {
  const location = useLocation();
  const autoScan = (location.state as { autoScan?: boolean } | null)?.autoScan;

  const { keyInfos, deleteKeyRing, getMnemonic, renameKeyRing, addZignerUnencrypted } =
    useStore(keyRingSelector);
  const { isPassword } = useStore(passwordSelector);
  const { all: penumbraWallets, zcashWallets, updateMultisigWallet } = useStore(walletsSelector);
  const enabledNetworks = useStore(selectEnabledNetworks);
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
  const [actionKind, setActionKind] = useState<ActionKind>('remove');
  const [step, setStep] = useState<RemovalStep>('idle');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState(false);
  const [phrase, setPhrase] = useState<string[]>([]);
  const [backupAcked, setBackupAcked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setStateError] = useState<string | null>(null);

  const navigate = usePopupNav();

  // -- add wallet state --
  const [scanning, setScanning] = useState(false);
  const [addSuccess, setAddSuccess] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // hidden paste mode — activated by tapping info box 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualInputRef = useRef(false);

  useEffect(() => {
    return () => {
      clearZignerState();
    };
  }, [clearZignerState]);

  // auto-start scanner when navigated with autoScan
  useEffect(() => {
    if (autoScan && !scanning && scanState === 'idle') {
      setScanning(true);
    }
  }, [autoScan]);

  // -- removal logic --
  const resetRemoval = () => {
    setRemovingId(null);
    setActionKind('remove');
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
    setActionKind('remove');
    setStep(vault.type === 'mnemonic' ? 'password' : 'confirm');
  };

  // Export the recovery phrase of ONE wallet (Keplr-style per-wallet action),
  // reusing the same password-gated reveal as removal - so it shares the
  // orphaned-vault handling and the single secret-in-state surface. Only
  // meaningful for mnemonic vaults (zigner/multisig hold no seed phrase here).
  const startExport = (vault: KeyInfo) => {
    resetRemoval();
    setRemovingId(vault.id);
    setRemovingType(vault.type);
    setActionKind('export');
    setStep('password');
  };

  const verifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!removingId) {
      return;
    }
    const ok = await isPassword(password);
    if (!ok) {
      setPasswordError(true);
      return;
    }
    try {
      setPhrase((await getMnemonic(removingId)).split(' '));
      setPassword('');
      // export -> straight to the reveal screen; remove -> the backup-ack step.
      setStep(actionKind === 'export' ? 'reveal' : 'backup');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('failed to decrypt vault')) {
        if (actionKind === 'export') {
          // Can't export a vault we can't decrypt - there is no phrase to show.
          // Surface it (the password card now renders `error`) and stay put;
          // the user's real backup is elsewhere. No delete escape here.
          setStateError(
            "this wallet's recovery phrase can't be read from storage (the vault is unreadable), so it cannot be exported here. use your existing backup.",
          );
        } else {
          // Escape hatch for an ORPHANED vault on REMOVE: its seed was sealed
          // under a previous password key and can't be decrypted, so we cannot
          // show the phrase to back up. Requiring backup would make it
          // permanently undeletable (the "delete + continue does nothing" bug -
          // the throw set an error the password card never rendered). Password is
          // verified (ownership), and this path is reachable ONLY on a decrypt
          // failure, so skipping backup is not a regression: the phrase is
          // already gone from storage. Jump to confirm, which states the reason.
          setPassword('');
          setStateError(
            "this wallet's recovery phrase can't be read from storage (the vault is unreadable). make sure you have it backed up elsewhere before removing - it cannot be shown here.",
          );
          setStep('confirm');
        }
      } else {
        setStateError(msg);
      }
    }
  };

  const executeRemoval = async () => {
    if (!removingId) {
      return;
    }
    setDeleting(true);
    setStateError(null);
    try {
      const isLast = keyInfos.length <= 1;
      await deleteKeyRing(removingId);
      if (isLast) {
        terminateNetworkWorker('zcash');
      }
      resetRemoval();
      if (isLast) {
        window.close();
      }
    } catch (err) {
      setStateError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const handleRename = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    await renameKeyRing(id, trimmed).catch(() => {});
    // for multisig vaults, also update the linked zcashWallet.label so the
    // multisig tab + overview show the same name.
    const linkedMs = zcashWallets.find(w => w.vaultId === id && w.multisig);
    if (linkedMs) {
      await updateMultisigWallet(linkedMs.id, { label: trimmed }).catch(() => {});
    }
  };

  // -- add wallet logic --
  const handleQrScan = useCallback(
    (data: string) => {
      setScanning(false);
      processQrData(data);
    },
    [processQrData],
  );

  const handleSecretTap = () => {
    clickCountRef.current += 1;
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }
    clickTimeoutRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, 3000);
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
          deviceId: walletImport.zidPublicKey ?? `penumbra-${Date.now()}`,
          zidPublicKey: walletImport.zidPublicKey,
        };
        await addZignerUnencrypted(
          zignerData,
          walletLabel || walletImport.label || 'zigner penumbra',
        );
      } else if (detectedNetwork === 'zcash' && zcashWalletImport) {
        // route through vault system so wallet gets vaultId and shows in wallet list
        const viewingKey =
          zcashWalletImport.ufvk ||
          (zcashWalletImport.orchardFvk
            ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
            : undefined);
        const zignerData: ZignerZafuImport = {
          viewingKey,
          accountIndex: zcashWalletImport.accountIndex,
          deviceId: zcashWalletImport.zidPublicKey ?? `zcash-${Date.now()}`,
          zidPublicKey: zcashWalletImport.zidPublicKey,
        };
        await addZignerUnencrypted(
          zignerData,
          walletLabel || zcashWalletImport.label || 'zigner zcash',
        );
      } else if (detectedNetwork === 'cosmos' && parsedCosmosExport && isLaunched('noble')) {
        const zignerData: ZignerZafuImport = {
          cosmosAddresses: parsedCosmosExport.addresses,
          publicKey: parsedCosmosExport.publicKey || undefined,
          accountIndex: parsedCosmosExport.accountIndex,
          deviceId: `cosmos-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner cosmos');
      } else if (detectedNetwork === 'polkadot' && parsedPolkadotExport && isLaunched('polkadot')) {
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
  const showScannedState =
    scanState === 'scanned' &&
    (walletImport || zcashWalletImport || parsedPolkadotExport || parsedCosmosExport);
  const showInitialState = scanState === 'idle' && !showManualInput;
  const hasSeedVault = keyInfos.some(v => v.type === 'mnemonic');

  return (
    <>
      {scanning && (
        <QrScanner
          onScan={handleQrScan}
          onError={err => {
            setError(err);
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
          title='scan zigner QR'
          description='point camera at your zigner FVK QR code'
        />
      )}
      <SettingsScreen title={title} backPath={PopupPath.INDEX}>
        <div className='flex flex-col gap-5'>
          {/* ── wallet list ── */}

          {keyInfos.length > 0 ? (
            <div className='flex flex-col divide-y divide-border/40 rounded-lg border border-border-soft bg-elev-1'>
              {keyInfos.map(v => {
                const networks: string[] = [];
                if (penumbraWallets.some(w => w.vaultId === v.id)) {
                  networks.push('penumbra');
                }
                if (zcashWallets.some(w => w.vaultId === v.id)) {
                  networks.push('zcash');
                }
                if (v.insensitive['cosmosAddresses'] && isLaunched('noble')) {
                  networks.push('cosmos');
                }
                if (v.insensitive['polkadotSs58'] && isLaunched('polkadot')) {
                  networks.push('polkadot');
                }
                // seed wallets derive keys for all networks
                if (v.type === 'mnemonic') {
                  if (!networks.includes('zcash')) {
                    networks.push('zcash');
                  }
                  if (!networks.includes('penumbra')) {
                    networks.push('penumbra');
                  }
                }
                // frost-multisig vaults support zcash
                if (v.type === 'frost-multisig' && !networks.includes('zcash')) {
                  networks.push('zcash');
                }

                // A seed derives keys for every network, but the tags should
                // reflect what the user has actually enabled (Settings >
                // Networks) - otherwise a Zcash-only wallet still shows a
                // penumbra tag. Only gate the top-level networks the user
                // toggles; leave cosmos/polkadot (already isLaunched-gated).
                // Guard against an empty list so tags never all vanish.
                const shownNetworks =
                  enabledNetworks.length === 0
                    ? networks
                    : networks.filter(n =>
                        n === 'penumbra' || n === 'zcash'
                          ? (enabledNetworks as string[]).includes(n)
                          : true,
                      );

                // multisig detail link
                const multisigWallet =
                  v.type === 'frost-multisig'
                    ? zcashWallets.find(w => w.vaultId === v.id && w.multisig)
                    : undefined;

                return (
                  <VaultRow
                    key={v.id}
                    vault={v}
                    networks={shownNetworks}
                    multisigWallet={multisigWallet}
                    onRemove={() => startRemoval(v)}
                    onExport={() => startExport(v)}
                    onRename={name => handleRename(v.id, name)}
                    disabled={step !== 'idle'}
                  />
                );
              })}
            </div>
          ) : (
            <p className='py-12 text-center text-sm text-fg-muted'>no wallets</p>
          )}

          {/* ── removal flow ── */}

          {removingVault && removingType === 'mnemonic' && step === 'password' && (
            <RemovalCard
              title={`${actionKind === 'export' ? 'export' : 'remove'} "${removingVault.name}"`}
            >
              <p className='text-xs text-fg-muted mb-3'>enter password to view recovery phrase.</p>
              <form onSubmit={e => void verifyPassword(e)} className='flex flex-col gap-2'>
                <input
                  type='password'
                  value={password}
                  autoFocus
                  onChange={e => {
                    setPassword(e.target.value);
                    setPasswordError(false);
                  }}
                  placeholder='password'
                  className='w-full bg-input border border-border-soft px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
                />
                {passwordError && <span className='text-xs text-red-400'>wrong password</span>}
                {error && <span className='text-xs text-red-400'>{error}</span>}
                <div className='flex gap-2 mt-1'>
                  <Btn onClick={resetRemoval}>cancel</Btn>
                  <Btn submit destructive disabled={!password}>
                    continue
                  </Btn>
                </div>
              </form>
            </RemovalCard>
          )}

          {removingVault && step === 'reveal' && (
            <RemovalCard title={`recovery phrase - "${removingVault.name}"`}>
              <p className='text-xs text-fg-muted mb-3'>
                write this down and keep it offline. anyone with it controls this wallet.
              </p>
              <div className='select-all cursor-text rounded-lg bg-canvas border border-border-soft p-3 mb-3 text-xs leading-relaxed break-words'>
                {phrase.join(' ')}
              </div>
              <div className='flex gap-2'>
                <Btn onClick={resetRemoval}>done</Btn>
              </div>
            </RemovalCard>
          )}

          {removingVault && removingType === 'mnemonic' && step === 'backup' && (
            <RemovalCard title='back up recovery phrase'>
              <div className='select-all cursor-text rounded-lg bg-canvas border border-border-soft p-3 mb-3 text-xs leading-relaxed break-words'>
                {phrase.join(' ')}
              </div>
              <label className='flex items-start gap-2 mb-3 cursor-pointer select-none'>
                <input
                  type='checkbox'
                  checked={backupAcked}
                  onChange={e => setBackupAcked(e.target.checked)}
                  className='mt-0.5'
                />
                <span className='text-xs text-fg-muted'>i have backed up my phrase</span>
              </label>
              <div className='flex gap-2'>
                <Btn onClick={resetRemoval}>cancel</Btn>
                <Btn destructive disabled={!backupAcked} onClick={() => setStep('confirm')}>
                  remove
                </Btn>
              </div>
            </RemovalCard>
          )}

          {removingVault && step === 'confirm' && (
            <RemovalCard title='confirm removal'>
              <p className='text-xs text-fg-muted mb-3'>
                "{removingVault.name}" will be permanently removed.
                {removingType === 'zigner-zafu' && ' re-import from zigner anytime.'}
                {removingType === 'frost-multisig' && ' you would need to run DKG again.'}
                {keyInfos.length <= 1 &&
                  ' this is your LAST wallet - removing it wipes all wallet data from this extension.'}
              </p>
              {error && <p className='text-xs text-red-400 mb-2'>{error}</p>}
              <div className='flex gap-2'>
                <Btn onClick={resetRemoval} disabled={deleting}>
                  cancel
                </Btn>
                <Btn destructive disabled={deleting} onClick={() => void executeRemoval()}>
                  {deleting ? 'removing...' : 'remove'}
                </Btn>
              </div>
            </RemovalCard>
          )}

          {error && step === 'idle' && <p className='text-xs text-red-400'>{error}</p>}

          {/* ── add wallet ── */}

          <div className='border-t border-border-soft pt-4'>
            {/* zigner info box — tap 10x for dev paste mode */}
            <div
              className='rounded-lg border border-border-soft bg-elev-1 p-3 mb-3'
              onClick={handleSecretTap}
            >
              <p className='text-xs text-fg-muted'>
                zafu zigner keeps spending keys offline - sign by QR.
              </p>
              <a
                href='https://zafu.pro/zigner'
                target='_blank'
                rel='noopener noreferrer'
                className='flex items-center gap-2 text-xs text-zigner-gold hover:underline mt-2'
              >
                <span className='i-ph-arrow-square-out h-3 w-3' />
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
                    <span className='text-label px-1 rounded-md bg-elev-2 text-fg-muted'>
                      {detectedNetwork}
                    </span>
                  </div>
                  <p className='text-label text-fg-muted mt-1 font-mono'>
                    {parsedCosmosExport ? (
                      <>
                        {parsedCosmosExport.addresses.map(a => a.address.slice(0, 10)).join(', ')}
                        ...
                      </>
                    ) : parsedPolkadotExport ? (
                      <>
                        {parsedPolkadotExport.address.slice(0, 8)}...
                        {parsedPolkadotExport.address.slice(-6)}
                      </>
                    ) : (
                      <>
                        account #
                        {walletImport?.accountIndex ?? zcashWalletImport?.accountIndex ?? 0}
                        {zcashWalletImport && (
                          <span className='ml-2'>
                            {zcashWalletImport.mainnet ? 'mainnet' : 'testnet'}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>
                <Input
                  placeholder='wallet label (optional)'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                />
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
                <p className='text-label text-fg-muted'>developer mode: paste QR hex data</p>
                <Input
                  placeholder='paste QR code hex (530301...)'
                  onChange={e => {
                    if (e.target.value.trim()) {
                      processQrData(e.target.value);
                    }
                  }}
                  className='font-mono text-xs'
                />
                <Input
                  placeholder='wallet label (optional)'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                />
                {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}
                <div className='flex gap-2'>
                  <Btn onClick={resetAdd}>cancel</Btn>
                  <Btn
                    primary
                    disabled={
                      (!walletImport &&
                        !zcashWalletImport &&
                        !parsedPolkadotExport &&
                        !parsedCosmosExport) ||
                      isAdding
                    }
                    onClick={() => void handleAddWallet()}
                  >
                    {isAdding ? 'adding...' : 'add wallet'}
                  </Btn>
                </div>
              </div>
            )}

            {/* initial: scan button + import seed */}
            {showInitialState && (
              <div className='flex flex-col gap-2'>
                <button
                  onClick={() => setScanning(true)}
                  className='w-full flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-zigner-gold hover:bg-primary/10 transition-colors'
                >
                  <span className='i-ph-scan size-4' />
                  scan zigner QR
                </button>
                {!hasSeedVault && (
                  <button
                    onClick={() => chrome.runtime.openOptionsPage()}
                    className='w-full rounded-lg border border-dashed border-border-soft py-2.5 text-xs text-fg-muted hover:text-fg-high hover:border-border-soft transition-colors'
                  >
                    + import seed phrase
                  </button>
                )}
                <button
                  onClick={() => navigate(PopupPath.SETTINGS_ADD_VIEWING_KEY)}
                  className='w-full rounded-lg border border-dashed border-border-soft py-2.5 text-xs text-fg-muted hover:text-fg-high hover:border-border-soft transition-colors'
                >
                  + add viewing key (watch only)
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
          {appendSlot}
        </div>
      </SettingsScreen>
    </>
  );
};

/* ── vault row with inline rename + network badges ── */

const VaultRow = ({
  vault,
  networks,
  multisigWallet,
  onRemove,
  onExport,
  onRename,
  disabled,
}: {
  vault: KeyInfo;
  networks: string[];
  multisigWallet?: import('../../../state/wallets').ZcashWalletJson;
  onRemove: () => void;
  onExport: () => void;
  onRename: (name: string) => void;
  disabled: boolean;
}) => {
  const navigate = usePopupNav();
  const { setMultisigHidden } = useStore(keyRingSelector);
  const [editing, setEditing] = useState(false);
  // Per-wallet actions menu (Keplr-style), rendered inline rather than as a
  // floating dropdown - matches the existing inline-expand idiom (the birthday
  // block below) and avoids a new popup-positioning component.
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(vault.name);
  const ref = useRef<HTMLInputElement>(null);
  const hasZcash = networks.includes('zcash');

  // zcash birthday, held as a height because that is what sync consumes —
  // but entered as a date, which is the only form a person actually knows.
  const [birthday, setBirthday] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  // When a birthday is already SET, the full picker is just clutter on every
  // row - collapse it to a compact "sync from <date>" line the user can tap to
  // edit. When UNSET we keep the full block open, because its "set a date if
  // older" nudge is what stops an old import from missing early notes.
  const [birthdayOpen, setBirthdayOpen] = useState(false);
  const birthdayKey = `zcashBirthday_${vault.id}`;

  useEffect(() => {
    if (!hasZcash) {
      return;
    }
    chrome.storage.local.get(birthdayKey).then(r => {
      const v = r[birthdayKey];
      if (v !== undefined) {
        setBirthday(String(v));
      }
    });
  }, [hasZcash, birthdayKey]);

  const birthdayNum = parseInt(birthday, 10);
  const birthdayValid = !isNaN(birthdayNum) && birthdayNum >= ZCASH_ORCHARD_ACTIVATION;
  const birthdayHint = birthday.trim() ? describeZcashHeight(birthdayNum) : null;

  const persist = (height: number | null) => {
    if (height === null) {
      setBirthday('');
      void chrome.storage.local.remove(birthdayKey);
      return;
    }
    const clamped = Math.max(ZCASH_ORCHARD_ACTIVATION, height);
    setBirthday(String(clamped));
    void chrome.storage.local.set({ [birthdayKey]: clamped });
  };

  /** date input → height. Dates are month-accurate at best, which is fine:
      an early birthday only costs scan time, never correctness. */
  const onPickDate = (value: string) => {
    if (!value) {
      persist(null);
      return;
    }
    persist(dateToBlock(new Date(value + 'T00:00:00Z')));
  };

  const saveBirthday = () => {
    if (birthday === '') {
      persist(null);
    } else if (!isNaN(birthdayNum) && birthdayNum > 0) {
      persist(birthdayNum);
    }
  };

  useEffect(() => {
    if (editing) {
      ref.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== vault.name) {
      onRename(t);
    } else {
      setDraft(vault.name);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      commit();
    }
    if (e.key === 'Escape') {
      setDraft(vault.name);
      setEditing(false);
    }
  };

  return (
    <div className='group px-3 py-2.5'>
      <div className='flex items-center gap-2'>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2'>
            {editing ? (
              <input
                ref={ref}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={onKey}
                autoFocus
                className='w-full text-sm bg-transparent border-b border-primary/50 outline-none'
              />
            ) : (
              <button
                onClick={() => {
                  setDraft(vault.name);
                  setEditing(true);
                }}
                className='text-sm text-left truncate hover:text-zigner-gold transition-colors'
              >
                {vault.name}
              </button>
            )}
            {!editing && <CustodyBadge vault={vault} />}
          </div>
          {networks.length > 0 && (
            <div className='flex gap-2 mt-1'>{networks.map(networkBadge)}</div>
          )}
        </div>
        <button
          onClick={() => setMenuOpen(o => !o)}
          disabled={disabled}
          aria-label='wallet actions'
          aria-expanded={menuOpen}
          className='p-1 text-fg-muted hover:text-fg-high transition-colors disabled:opacity-50'
        >
          <span className='i-ph-dots-three-vertical size-4' />
        </button>
      </div>

      {/* per-wallet actions: rename, export recovery phrase (mnemonic only),
          remove. Rename is also still available by clicking the name above. */}
      {menuOpen && (
        <div className='mt-2 flex flex-wrap gap-2 border-t border-border-soft/70 pt-2'>
          <button
            type='button'
            disabled={disabled}
            onClick={() => {
              setMenuOpen(false);
              setDraft(vault.name);
              setEditing(true);
            }}
            className='text-label text-fg-muted hover:text-fg-high transition-colors disabled:opacity-50'
          >
            rename
          </button>
          {vault.type === 'mnemonic' && (
            <button
              type='button'
              disabled={disabled}
              onClick={() => {
                setMenuOpen(false);
                onExport();
              }}
              className='text-label text-zigner-gold hover:underline transition-colors disabled:opacity-50'
            >
              export recovery phrase
            </button>
          )}
          <button
            type='button'
            disabled={disabled}
            onClick={() => {
              setMenuOpen(false);
              onRemove();
            }}
            className='ml-auto text-label text-fg-muted hover:text-red-400 transition-colors disabled:opacity-50'
          >
            remove
          </button>
        </div>
      )}

      {/* zcash sync start.

          Asked as a date, not a height. "when did you first use this wallet"
          is something a person knows; block 2,910,104 is not, and a bare
          number gives no clue which chain it belongs to — a seed vault
          derives keys for penumbra too, so both badges sit right above this
          field. The height still exists (sync consumes it) but it lives
          under `advanced`, alongside the date it resolves to. */}
      {hasZcash && birthdayValid && !birthdayOpen && (
        // Compact summary for a wallet whose sync-start is already set.
        <button
          type='button'
          onClick={() => setBirthdayOpen(true)}
          title='zcash sync start - tap to change'
          className='mt-2 flex w-full items-center gap-2 rounded-md border border-border-soft/70 px-2.5 py-1.5 text-left transition-colors hover:border-fg-muted'
        >
          <span className='i-ph-calendar-blank size-3.5 text-fg-muted shrink-0' />
          <span className='text-label text-fg-muted'>
            zcash sync from {formatDateInput(blockToDate(birthdayNum))}
          </span>
          <span className='i-ph-pencil-simple ml-auto size-3.5 text-fg-dim' />
        </button>
      )}

      {hasZcash && !(birthdayValid && !birthdayOpen) && (
        <div className='mt-2 rounded-md border border-border-soft/70 px-2.5 py-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <span
              className='i-ph-calendar-blank size-3.5 text-fg-muted shrink-0'
              title='when this wallet was first used - scanning starts here'
            />
            <span
              className='text-label text-fg-muted whitespace-nowrap'
              title='Zcash only - sets where Zcash sync starts. Penumbra does not scan from a date.'
            >
              zcash first used
            </span>
            <input
              type='date'
              min={formatDateInput(blockToDate(ZCASH_ORCHARD_ACTIVATION))}
              max={formatDateInput(new Date())}
              value={birthdayValid ? formatDateInput(blockToDate(birthdayNum)) : ''}
              onChange={e => onPickDate(e.target.value)}
              className='bg-input border border-border-soft px-2 py-1.5 text-label font-mono rounded focus:outline-none focus:border-primary/50'
            />
            <button
              type='button'
              onClick={() => setShowAdvanced(v => !v)}
              title='set the start block directly'
              className='ml-auto text-label text-fg-dim hover:text-fg-muted transition-colors'
            >
              <span
                className={cn(
                  'i-ph-sliders-horizontal size-3.5 transition-transform',
                  showAdvanced && 'text-fg-muted',
                )}
              />
            </button>
          </div>

          {!birthdayValid && (
            // Unset is a fine default, not an error - so no warning colour or
            // icon. "auto" is the same word the advanced block input uses for
            // this state, so the two read as one idea. The nudge stays because
            // an OLD imported seed left on auto misses its early notes, but it
            // is a calm aside, not an alarm.
            <p className='text-label text-fg-dim mt-1'>
              auto · scans recent blocks, set a date if older
            </p>
          )}

          {showAdvanced && (
            <div className='mt-2 flex flex-wrap items-center gap-2 border-t border-border-soft/70 pt-2'>
              <span className='text-label text-fg-muted whitespace-nowrap'>block</span>
              <input
                type='number'
                min={ZCASH_ORCHARD_ACTIVATION}
                step='1000'
                value={birthday}
                onChange={e => setBirthday(e.target.value)}
                onBlur={saveBirthday}
                onKeyDown={e => e.key === 'Enter' && saveBirthday()}
                placeholder='auto'
                className='w-24 bg-input border border-border-soft px-2 py-1.5 text-label font-mono rounded focus:outline-none focus:border-primary/50'
              />
              {birthdayHint && (
                <span className={cn('text-label', birthdayHint.ok ? 'text-fg-dim' : 'text-hanko')}>
                  {birthdayHint.text}
                </span>
              )}
              {birthday && (
                <button
                  type='button'
                  onClick={() => persist(null)}
                  className='ml-auto text-label text-fg-dim hover:text-hanko transition-colors'
                >
                  clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {vault.type === 'zigner-zafu' && hasZcash && (
        <button
          onClick={() => navigate(PopupPath.NOTE_SYNC)}
          title='scan it on zigner to verify your notes - re-sync after you send'
          className='flex items-center gap-2 mt-2 w-full rounded-md border border-border-soft px-3 py-2 text-left hover:border-fg-muted'
        >
          <span className='i-ph-qr-code size-4 text-fg-high shrink-0' />
          <span className='text-xs font-medium text-fg-high'>sync to zigner</span>
          <span className='i-ph-caret-right size-3.5 text-fg-dim ml-auto shrink-0' />
        </button>
      )}

      {multisigWallet && (
        <div className='flex items-center gap-2 mt-2'>
          {multisigWallet.multisig?.hidden ? (
            // app-managed (poker) table: the multisig manager hides it, so a plain "manage" link
            // dead-ends. Offer recovery — unhide it into a normal, selectable, co-signable multisig.
            <button
              onClick={() => void setMultisigHidden(vault.id, false)}
              className='inline-flex items-center gap-1 text-label text-zigner-gold hover:underline'
              title='make this app-managed table a normal multisig you can select and co-sign'
            >
              recover / take control
              <span className='i-ph-arrow-right size-3' />
            </button>
          ) : (
            <button
              onClick={() => navigate(PopupPath.MULTISIG)}
              className='inline-flex items-center gap-1 text-label text-zigner-gold hover:underline'
            >
              manage in multisig tab
              <span className='i-ph-arrow-right size-3' />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/* ── shared ui ── */

const RemovalCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className='rounded-lg border border-red-500/20 bg-elev-1 p-4'>
    <div className='text-sm font-medium text-red-400 mb-2'>{title}</div>
    {children}
  </div>
);

const Btn = ({
  children,
  onClick,
  submit,
  destructive,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  submit?: boolean;
  destructive?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) => (
  <Button
    type={submit ? 'submit' : 'button'}
    onClick={onClick}
    disabled={disabled}
    variant={destructive ? 'destructiveSecondary' : primary ? 'default' : 'secondary'}
    size='md'
    className='flex-1 rounded-lg text-xs'
  >
    {children}
  </Button>
);
