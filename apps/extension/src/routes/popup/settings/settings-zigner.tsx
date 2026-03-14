import { EyeOpenIcon, TrashIcon, ExternalLinkIcon, Link2Icon, CameraIcon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { walletsSelector } from '../../../state/wallets';
import { zignerConnectSelector } from '../../../state/zigner';
import { keyRingSelector, selectEnabledNetworks, type ZignerZafuImport } from '../../../state/keyring';
import { SettingsScreen } from './settings-screen';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Switch } from '@repo/ui/components/ui/switch';
import { useState, useRef, useEffect, useCallback } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { QrScanner } from '../../../shared/components/qr-scanner';

/** Check if a wallet custody is watch-only (Zigner) */
function isZignerWallet(custody: { encryptedSeedPhrase?: unknown; airgapSigner?: unknown }): boolean {
  return 'airgapSigner' in custody;
}

export const SettingsZigner = () => {
  const { all, zcashWallets, addAirgapSignerWallet, addZcashWallet, removeWallet, removeZcashWallet } = useStore(walletsSelector);
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
  const { addZignerUnencrypted, keyInfos, deleteKeyRing } = useStore(keyRingSelector);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const hasPolkadot = enabledNetworks.includes('polkadot') || enabledNetworks.includes('kusama');

  const [success, setSuccess] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [deletingVaultId, setDeletingVaultId] = useState<string | null>(null);
  const [confirmDeleteVault, setConfirmDeleteVault] = useState<string | null>(null);
  const [vaultLegacyMode, setVaultLegacyMode] = useState(false);
  const [scanning, setScanning] = useState(false);

  const handleQrScan = useCallback((data: string) => {
    setScanning(false);
    processQrData(data);
  }, [processQrData]);

  const zignerWallets = all
    .map((wallet, index) => ({ wallet, index }))
    .filter(({ wallet }) => isZignerWallet(wallet.custody));

  const cosmosVaults = keyInfos.filter(k =>
    k.type === 'zigner-zafu' && Array.isArray(k.insensitive['cosmosAddresses'])
  );
  const polkadotVaults = keyInfos.filter(k =>
    k.type === 'zigner-zafu' && typeof k.insensitive['polkadotSs58'] === 'string'
  );

  // hidden paste mode - activated by clicking icon 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const manualInputRef = useRef(false);

  useEffect(() => {
    void localExtStorage.get('polkadotVaultSettings').then(settings => {
      setVaultLegacyMode(settings?.legacyMode ?? false);
    });
  }, []);

  const handleVaultLegacyModeChange = async (enabled: boolean) => {
    setVaultLegacyMode(enabled);
    await localExtStorage.set('polkadotVaultSettings', { legacyMode: enabled });
  };

  useEffect(() => {
    return () => { clearZignerState(); };
  }, [clearZignerState]);

  const handleIconClick = () => {
    clickCountRef.current += 1;
    if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    clickTimeoutRef.current = setTimeout(() => { clickCountRef.current = 0; }, 3000);
    if (clickCountRef.current >= 10) {
      manualInputRef.current = true;
      setScanState('idle');
      clickCountRef.current = 0;
    }
  };

  const handleManualInput = (value: string) => {
    if (value.trim()) processQrData(value);
  };

  const handleDeleteVault = async (vaultId: string) => {
    try {
      setDeletingVaultId(vaultId);
      await deleteKeyRing(vaultId);
      setConfirmDeleteVault(null);
    } catch (cause) {
      setError(`failed to remove wallet: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setDeletingVaultId(null);
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
        await addAirgapSignerWallet(walletImport);
      } else if (detectedNetwork === 'zcash' && zcashWalletImport) {
        await addZcashWallet(zcashWalletImport);
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

      setSuccess(true);
      clearZignerState();
      manualInputRef.current = false;
      setTimeout(() => setSuccess(false), 3000);
    } catch (cause) {
      setError(`failed to add wallet: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setIsAdding(false);
    }
  };

  const resetForm = () => {
    clearZignerState();
    manualInputRef.current = false;
  };

  const handleDeleteWallet = async (index: number) => {
    try {
      setDeletingIndex(index);
      await removeWallet(index);
      setConfirmDelete(null);
    } catch (cause) {
      setError(`failed to remove wallet: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setDeletingIndex(null);
    }
  };

  const showManualInput = manualInputRef.current && scanState !== 'scanned';
  const showScannedState = scanState === 'scanned' && (walletImport || zcashWalletImport || parsedPolkadotExport || parsedCosmosExport);
  const showInitialState = scanState === 'idle' && !showManualInput;

  return (
    <SettingsScreen
      title='zigner'
      IconComponent={() => (
        <div onClick={handleIconClick}>
          <EyeOpenIcon className='size-5' />
        </div>
      )}
    >
      <div className='flex flex-col gap-4'>
        {/* info */}
        <div className='border border-border bg-card p-3'>
          <p className='text-xs text-muted-foreground'>
            zafu zigner keeps spending keys offline. transactions require QR code signing with your device.
          </p>
          <a
            href='https://zigner.rotko.net'
            target='_blank'
            rel='noopener noreferrer'
            className='flex items-center gap-1.5 text-xs text-primary hover:underline mt-2'
          >
            <ExternalLinkIcon className='h-3 w-3' />
            download zafu zigner
          </a>
        </div>

        {/* penumbra wallets */}
        {zignerWallets.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2'>penumbra</p>
            <div className='flex flex-col gap-1'>
              {zignerWallets.map(({ wallet, index }) => (
                <div key={wallet.id} className='flex items-center justify-between border border-border/40 bg-card p-3'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <EyeOpenIcon className='size-3 text-purple-500 flex-shrink-0' />
                    <span className='text-sm truncate'>{wallet.label}</span>
                  </div>
                  {confirmDelete === index ? (
                    <div className='flex items-center gap-2'>
                      <Button variant='destructive' size='sm' onClick={() => handleDeleteWallet(index)} disabled={deletingIndex === index || all.length <= 1}>
                        {deletingIndex === index ? 'removing...' : 'confirm'}
                      </Button>
                      <Button variant='secondary' size='sm' onClick={() => setConfirmDelete(null)} disabled={deletingIndex === index}>
                        cancel
                      </Button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(index)}
                      disabled={all.length <= 1}
                      title={all.length <= 1 ? 'cannot remove the last wallet' : 'remove wallet'}
                      className='p-1 text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-30'
                    >
                      <TrashIcon className='size-4' />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* zcash wallets */}
        {zcashWallets.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2'>zcash</p>
            <div className='flex flex-col gap-1'>
              {zcashWallets.map((wallet, index) => (
                <div key={wallet.id} className='flex items-center justify-between border border-border/40 bg-card p-3'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <EyeOpenIcon className='size-3 text-yellow-500 flex-shrink-0' />
                    <span className='text-sm truncate'>{wallet.label}</span>
                    <span className='text-[10px] px-1 bg-muted text-muted-foreground'>
                      {wallet.mainnet ? 'mainnet' : 'testnet'}
                    </span>
                  </div>
                  <button
                    onClick={() => removeZcashWallet(index)}
                    title='remove wallet'
                    className='p-1 text-muted-foreground hover:text-red-400 transition-colors'
                  >
                    <TrashIcon className='size-4' />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* cosmos wallets */}
        {cosmosVaults.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2'>cosmos</p>
            <div className='flex flex-col gap-1'>
              {cosmosVaults.map(vault => {
                const addrs = vault.insensitive['cosmosAddresses'] as
                  { chainId: string; address: string; prefix: string }[];
                return (
                  <div key={vault.id} className='flex items-center justify-between border border-border/40 bg-card p-3'>
                    <div className='flex flex-col gap-1 min-w-0'>
                      <div className='flex items-center gap-2'>
                        <EyeOpenIcon className='size-3 text-pink-500 flex-shrink-0' />
                        <span className='text-sm truncate'>{vault.name}</span>
                      </div>
                      {addrs.map(a => (
                        <span key={a.chainId} className='text-[10px] font-mono text-muted-foreground pl-5'>
                          {a.chainId}: {a.address.slice(0, 10)}...{a.address.slice(-6)}
                        </span>
                      ))}
                    </div>
                    {confirmDeleteVault === vault.id ? (
                      <div className='flex items-center gap-2'>
                        <Button variant='destructive' size='sm' onClick={() => void handleDeleteVault(vault.id)} disabled={deletingVaultId === vault.id}>
                          {deletingVaultId === vault.id ? 'removing...' : 'confirm'}
                        </Button>
                        <Button variant='secondary' size='sm' onClick={() => setConfirmDeleteVault(null)} disabled={deletingVaultId === vault.id}>
                          cancel
                        </Button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmDeleteVault(vault.id)} className='p-1 text-muted-foreground hover:text-red-400 transition-colors'>
                        <TrashIcon className='size-4' />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* polkadot wallets */}
        {polkadotVaults.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2'>polkadot</p>
            <div className='flex flex-col gap-1'>
              {polkadotVaults.map(vault => {
                const ss58 = vault.insensitive['polkadotSs58'] as string;
                return (
                  <div key={vault.id} className='flex items-center justify-between border border-border/40 bg-card p-3'>
                    <div className='flex items-center gap-2 min-w-0'>
                      <EyeOpenIcon className='size-3 text-pink-500 flex-shrink-0' />
                      <span className='text-sm truncate'>{vault.name}</span>
                      <span className='text-[10px] font-mono text-muted-foreground'>
                        {ss58.slice(0, 8)}...{ss58.slice(-6)}
                      </span>
                    </div>
                    {confirmDeleteVault === vault.id ? (
                      <div className='flex items-center gap-2'>
                        <Button variant='destructive' size='sm' onClick={() => void handleDeleteVault(vault.id)} disabled={deletingVaultId === vault.id}>
                          {deletingVaultId === vault.id ? 'removing...' : 'confirm'}
                        </Button>
                        <Button variant='secondary' size='sm' onClick={() => setConfirmDeleteVault(null)} disabled={deletingVaultId === vault.id}>
                          cancel
                        </Button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmDeleteVault(vault.id)} className='p-1 text-muted-foreground hover:text-red-400 transition-colors'>
                        <TrashIcon className='size-4' />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* polkadot vault settings — only for polkadot/kusama users */}
        {hasPolkadot && (
          <div className='border-t border-border pt-4'>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2'>polkadot vault</p>
            <div className='flex flex-col gap-2'>
              <div className='flex items-center justify-between border border-border/40 bg-card p-3'>
                <div className='flex flex-col'>
                  <span className='text-sm'>legacy mode</span>
                  <span className='text-[10px] text-muted-foreground'>
                    for older parity signer / polkadot vault devices
                  </span>
                </div>
                <Switch
                  checked={vaultLegacyMode}
                  onCheckedChange={v => void handleVaultLegacyModeChange(v)}
                />
              </div>
              {vaultLegacyMode && (
                <div className='border border-yellow-500/30 bg-yellow-500/5 p-3'>
                  <p className='text-[10px] text-yellow-400 mb-1'>
                    legacy mode requires up-to-date metadata on your device
                  </p>
                  <a
                    href='https://metadata.novasama.io/'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='flex items-center gap-1 text-[10px] text-primary hover:underline'
                  >
                    <Link2Icon className='size-3' />
                    update metadata at novasama.io
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* success */}
        {success && (
          <div className='border border-green-500/30 bg-green-500/5 p-3 text-xs text-green-400'>
            wallet added successfully
          </div>
        )}

        {/* add wallet */}
        <div className='border-t border-border pt-4'>
          <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2'>add wallet</p>

          {showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-[10px] text-muted-foreground'>developer mode: paste QR hex data</p>
              <Input
                placeholder='paste QR code hex (530301...)'
                onChange={e => handleManualInput(e.target.value)}
                className='font-mono text-xs'
              />
              <Input
                placeholder='wallet label (optional)'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />
              {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}
              <div className='flex gap-2'>
                <Button variant='secondary' className='flex-1' onClick={resetForm}>cancel</Button>
                <Button
                  className='flex-1'
                  onClick={handleAddWallet}
                  disabled={(!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) || isAdding}
                >
                  {isAdding ? 'adding...' : 'add wallet'}
                </Button>
              </div>
            </div>
          )}

          {showScannedState && (
            <div className='flex flex-col gap-3'>
              <div className='border border-green-500/30 bg-green-500/5 p-3'>
                <div className='flex items-center gap-2'>
                  <p className='text-xs text-green-400'>qr code scanned</p>
                  <span className='text-[10px] px-1 bg-muted text-muted-foreground'>{detectedNetwork}</span>
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
              <Input
                placeholder='wallet label (optional)'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />
              {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}
              <div className='flex gap-2'>
                <Button variant='secondary' className='flex-1' onClick={resetForm}>cancel</Button>
                <Button className='flex-1' onClick={handleAddWallet} disabled={isAdding}>
                  {isAdding ? 'adding...' : 'add wallet'}
                </Button>
              </div>
            </div>
          )}

          {showInitialState && (
            <div className='flex flex-col gap-2'>
              <Button variant='secondary' className='w-full' onClick={() => setScanning(true)}>
                <CameraIcon className='size-4 mr-2' />
                scan QR code
              </Button>
              {errorMessage && <p className='text-xs text-red-400 text-center'>{errorMessage}</p>}
            </div>
          )}

          {scanState === 'error' && !showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-xs text-red-400'>{errorMessage}</p>
              <Button variant='secondary' onClick={resetForm}>try again</Button>
            </div>
          )}
        </div>
      </div>

      {scanning && (
        <QrScanner
          onScan={handleQrScan}
          onError={(err) => { setError(err); setScanning(false); }}
          onClose={() => setScanning(false)}
          title='scan zigner QR'
          description='point camera at your zigner device FVK QR code'
        />
      )}
    </SettingsScreen>
  );
};
