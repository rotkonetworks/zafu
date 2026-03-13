import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpIcon, ArrowDownIcon, CopyIcon, CheckIcon, DesktopIcon, ViewVerticalIcon } from '@radix-ui/react-icons';

import { useStore } from '../../../state';
import { selectActiveNetwork, selectEffectiveKeyInfo, selectPenumbraAccount, selectSetPenumbraAccount, keyRingSelector, type NetworkType } from '../../../state/keyring';
import { PenumbraAccountPicker } from '../../../components/penumbra-account-picker';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
import { openInDedicatedWindow, openInSidePanel } from '../../../utils/navigate';
import { isSidePanel, isDedicatedWindow } from '../../../utils/popup-detection';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { usePreloadBalances } from '../../../hooks/use-preload';
import { useActiveAddress } from '../../../hooks/use-address';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { usePolkadotPublicKey } from '../../../hooks/use-polkadot-key';
import { useCosmosAssets } from '../../../hooks/cosmos-balance';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { useTransparentBalance } from '../../../hooks/zcash-transparent-balance';
import {
  shieldInWorker,
  buildUnsignedShieldInWorker,
  completeShieldInWorker,
  spawnNetworkWorker,
  startSyncInWorker,
  startWatchOnlySyncInWorker,
  stopSyncInWorker,
  resetSyncInWorker,
  getBalanceInWorker,
  type ShieldUnsignedResult,
} from '../../../state/keyring/network-worker';
import {
  encodeZcashShieldingSignRequest,
  isZcashSignatureQR,
  parseZcashSignatureResponse,
} from '@repo/wallet/zcash-zigner';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

/** lazy load network-specific content - only load when needed */
const AssetsTable = lazy(() => import('./assets-table').then(m => ({ default: m.AssetsTable })));
const PolkadotAssets = lazy(() => import('./polkadot-assets').then(m => ({ default: m.PolkadotAssets })));
const BlockSync = lazy(() => import('./block-sync').then(m => ({ default: m.BlockSync })));

export interface PopupLoaderData {
  fullSyncHeight?: number;
}

export const popupIndexLoader = async (): Promise<Response | PopupLoaderData> => {
  await needsOnboard();
  const redirect = await needsLogin();
  if (redirect) return redirect;
  return { fullSyncHeight: await localExtStorage.get('fullSyncHeight') };
};

export const PopupIndex = () => {
  // atomic selectors - each only re-renders when its value changes
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const setPenumbraAccount = useStore(selectSetPenumbraAccount);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const { address } = useActiveAddress();
  const { publicKey: polkadotPublicKey } = usePolkadotPublicKey();

  const [copied, setCopied] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const sendMenuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // check if we're in side panel or dedicated window (can navigate normally)
  const [canNavigateNormally] = useState(() => isSidePanel() || isDedicatedWindow());

  // preload balances in background for instant display
  usePreloadBalances(penumbraAccount);

  // close send menu when clicking outside
  useEffect(() => {
    if (!sendMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (sendMenuRef.current && !sendMenuRef.current.contains(e.target as Node)) {
        setSendMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sendMenuOpen]);

  const handleSendClick = useCallback(() => {
    if (canNavigateNormally) {
      // in side panel or dedicated window - navigate normally
      navigate(PopupPath.SEND);
    } else {
      // in popup - show menu
      setSendMenuOpen(prev => !prev);
    }
  }, [canNavigateNormally, navigate]);

  // dismiss backup reminder on first load
  useEffect(() => {
    void localExtStorage.get('backupReminderSeen').then(seen => {
      if (seen === false) void localExtStorage.set('backupReminderSeen', true);
    });
  }, []);

  const copyAddress = useCallback(() => {
    if (!address) return;
    setCopied(true);
    void navigator.clipboard.writeText(address);
    setTimeout(() => setCopied(false), 1200);
  }, [address]);

  // derive wallet name - zcash can come from zigner import OR mnemonic derivation
  const walletName = activeNetwork === 'zcash'
    ? activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet'
    : selectedKeyInfo?.name ?? 'no wallet';

  // truncate address for display
  const displayAddress = address
    ? `${address.slice(0, 12)}...${address.slice(-8)}`
    : walletName;

  return (
    <div className='flex min-h-full flex-col'>
      <div className='flex flex-col gap-3 p-4'>
        {activeNetwork === 'penumbra' && (
          <PenumbraAccountPicker account={penumbraAccount} onChange={setPenumbraAccount} />
        )}
        {/* address + actions row */}
        <div className='flex items-center justify-between border border-border/40 bg-card p-4'>
          <div>
            {activeNetwork !== 'zcash' && (
              <>
                <div className='text-xs text-muted-foreground'>balance</div>
                <div className='text-2xl font-semibold tabular-nums text-foreground'>$0.00</div>
              </>
            )}
            <button
              onClick={copyAddress}
              disabled={!address}
              className='mt-1 flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-100 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed'
            >
              <span className='font-mono'>{displayAddress}</span>
              {address && (copied ? <CheckIcon className='h-3 w-3' /> : <CopyIcon className='h-3 w-3' />)}
            </button>
          </div>

          <div className='flex gap-2'>
            <button
              onClick={() => navigate(PopupPath.RECEIVE)}
              className='flex h-10 w-10 items-center justify-center bg-muted transition-all duration-100 hover:bg-muted/80 active:scale-95'
              title='receive'
            >
              <ArrowDownIcon className='h-5 w-5' />
            </button>
            <div className='relative' ref={sendMenuRef}>
              <button
                onClick={handleSendClick}
                className='flex h-10 w-10 items-center justify-center bg-primary text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95'
                title='send'
              >
                <ArrowUpIcon className='h-5 w-5' />
              </button>
              {/* send options menu - only shown in popup mode */}
              {sendMenuOpen && (
                <div className='absolute right-0 top-full mt-1 z-20 w-48 rounded-lg border border-border bg-background shadow-lg py-1'>
                  <button
                    onClick={() => {
                      setSendMenuOpen(false);
                      void openInDedicatedWindow(PopupPath.SEND);
                    }}
                    className='flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors'
                  >
                    <DesktopIcon className='h-4 w-4' />
                    open in new window
                  </button>
                  <button
                    onClick={() => {
                      setSendMenuOpen(false);
                      void openInSidePanel(PopupPath.SEND);
                    }}
                    className='flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors'
                  >
                    <ViewVerticalIcon className='h-4 w-4' />
                    open in side panel
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* network-specific content - lazy loaded with skeleton */}
        <Suspense fallback={<AssetListSkeleton rows={4} />}>
          <NetworkContent
            network={activeNetwork}
            penumbraAccount={penumbraAccount}
            zcashWallet={activeZcashWallet}
            polkadotPublicKey={polkadotPublicKey}
            hasMnemonic={selectedKeyInfo?.type === 'mnemonic'}
          />
        </Suspense>
      </div>
    </div>
  );
};

/** network-specific content - split out to minimize re-renders */
const NetworkContent = ({
  network,
  penumbraAccount,
  zcashWallet,
  polkadotPublicKey,
  hasMnemonic,
}: {
  network: NetworkType;
  penumbraAccount: number;
  zcashWallet?: { label: string; mainnet: boolean; orchardFvk?: string; ufvk?: string; id?: string };
  polkadotPublicKey?: string;
  hasMnemonic?: boolean;
}) => {
  switch (network) {
    case 'penumbra':
      return (
        <div className='flex-1'>
          {/* sync status bar */}
          <Suspense fallback={null}>
            <div className='mb-3'>
              <BlockSync />
            </div>
          </Suspense>
          <div className='mb-2 text-xs font-medium text-muted-foreground'>assets</div>
          <AssetsTable account={penumbraAccount} />
        </div>
      );

    case 'zcash':
      return <ZcashContent hasMnemonic={hasMnemonic} watchOnly={zcashWallet} />;

    case 'polkadot':
      return <PolkadotContent publicKey={polkadotPublicKey} />;

    case 'kusama':
      return <PolkadotContent publicKey={polkadotPublicKey} relay='kusama' />;

    case 'osmosis':
    case 'noble':
    case 'nomic':
    case 'celestia':
      return <CosmosContent chainId={network as CosmosChainId} />;

    default:
      return <NetworkPlaceholder network={network} />;
  }
};

/** zcash-specific content — zashi-inspired combined balance */
const ZcashContent = ({
  hasMnemonic,
  watchOnly,
}: {
  hasMnemonic?: boolean;
  watchOnly?: { label: string; mainnet: boolean; orchardFvk?: string; ufvk?: string; id?: string };
}) => {
  const hasWallet = !!(hasMnemonic || watchOnly);
  const isMainnet = watchOnly?.mainnet ?? true;
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const { syncStatus, chainTip, workerSyncHeight, error: syncError } = useZcashSyncStatus();

  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyRing = useStore(keyRingSelector);

  // orchard balance from worker (zatoshi string)
  const [orchardZat, setOrchardZat] = useState(0n);

  // wallet birthday — used to show progress relative to start, not block 0
  const [walletBirthday, setWalletBirthday] = useState(0);
  useEffect(() => {
    if (!hasWallet || !selectedKeyInfo) return;
    const key = `zcashBirthday_${selectedKeyInfo.id}`;
    chrome.storage.local.get(key, r => {
      if (typeof r[key] === 'number') setWalletBirthday(r[key] as number);
    });
  }, [hasWallet, selectedKeyInfo?.id]);

  // sync lifecycle managed by useZcashAutoSync in PopupLayout
  // this component only reads sync status and balance

  // fetch orchard balance from worker on each sync-progress event
  useEffect(() => {
    if (!selectedKeyInfo) return;
    const walletId = selectedKeyInfo.id;

    const fetchBalance = () => {
      getBalanceInWorker('zcash', walletId)
        .then(bal => setOrchardZat(BigInt(bal)))
        .catch(() => {}); // worker not ready yet, ignore
    };

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') return;
      fetchBalance();
    };

    window.addEventListener('network-sync-progress', handler);
    // fetch on mount in case sync already ran, plus retry after worker init delay
    fetchBalance();
    const retryTimer = setTimeout(fetchBalance, 2000);
    return () => {
      window.removeEventListener('network-sync-progress', handler);
      clearTimeout(retryTimer);
    };
  }, [selectedKeyInfo?.id]);

  // derive transparent addresses for UTXO lookup (shared hook with caching)
  const { tAddresses } = useTransparentAddresses(isMainnet);

  const { totalZat: transparentZat, isLoading: utxoLoading } = useTransparentBalance(tAddresses);

  // shielding state
  const [shielding, setShielding] = useState(false);
  const [shieldTxid, setShieldTxid] = useState<string | null>(null);
  const [shieldError, setShieldError] = useState<string | null>(null);

  // zigner shielding state
  const [zignerShieldStep, setZignerShieldStep] = useState<
    'idle' | 'building' | 'show_qr' | 'scanning' | 'broadcasting' | 'complete' | 'error'
  >('idle');
  const [shieldSignRequestQr, setShieldSignRequestQr] = useState<string | null>(null);
  const [shieldUnsignedData, setShieldUnsignedData] = useState<ShieldUnsignedResult | null>(null);
  const [zignerShieldTxid, setZignerShieldTxid] = useState<string | null>(null);
  const [zignerShieldError, setZignerShieldError] = useState<string | null>(null);

  const handleZignerShield = useCallback(async () => {
    if (!watchOnly || !selectedKeyInfo) return;
    const ufvk = watchOnly.ufvk ?? (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
    if (!ufvk) return;

    setZignerShieldStep('building');
    setZignerShieldTxid(null);
    setZignerShieldError(null);

    try {
      await spawnNetworkWorker('zcash');
      const addressIndexMap: Record<string, number> = {};
      tAddresses.forEach((addr, i) => { addressIndexMap[addr] = i; });

      const result = await buildUnsignedShieldInWorker(
        'zcash', selectedKeyInfo.id, zidecarUrl,
        tAddresses, isMainnet, ufvk, addressIndexMap,
      );
      setShieldUnsignedData(result);

      // encode QR sign request
      const sighashBytes = result.sighashes.map(h => {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
        return bytes;
      });

      const qrHex = encodeZcashShieldingSignRequest({
        accountIndex: watchOnly.id ? 0 : 0,
        sighashes: sighashBytes,
        addressIndices: result.addressIndices,
        summary: result.summary,
        mainnet: isMainnet,
      });

      setShieldSignRequestQr(qrHex);
      setZignerShieldStep('show_qr');
    } catch (err) {
      setZignerShieldError(err instanceof Error ? err.message : String(err));
      setZignerShieldStep('error');
    }
  }, [watchOnly, selectedKeyInfo, tAddresses, isMainnet, zidecarUrl]);

  const handleZignerShieldSigScanned = useCallback(async (data: string) => {
    if (!isZcashSignatureQR(data)) {
      setZignerShieldError('invalid signature QR code');
      setZignerShieldStep('error');
      return;
    }

    try {
      const sigResponse = parseZcashSignatureResponse(data);

      if (!shieldUnsignedData || !selectedKeyInfo) {
        throw new Error('missing unsigned transaction data');
      }

      // verify the returned sighash matches what we sent
      const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
      const responseSighash = toHex(sigResponse.sighash);
      if (shieldUnsignedData.sighashes.length > 0 && responseSighash !== shieldUnsignedData.sighashes[0]) {
        throw new Error('sighash mismatch — signature is for a different transaction');
      }

      setZignerShieldStep('broadcasting');

      // zigner returns each transparent sig as: DER_sig + 0x01(hashtype) + compressed_pubkey(33 bytes)
      // split into sig (with hashtype) and pubkey
      const signatures = sigResponse.transparentSigs.map(combined => {
        const pubkey = combined.slice(-33);
        const sig = combined.slice(0, -33);
        const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
        return { sig_hex: toHex(sig), pubkey_hex: toHex(pubkey) };
      });

      const result = await completeShieldInWorker(
        'zcash', selectedKeyInfo.id, zidecarUrl,
        shieldUnsignedData.unsignedTxHex, signatures,
      );

      setZignerShieldTxid(result.txid);
      setZignerShieldStep('complete');
    } catch (err) {
      setZignerShieldError(err instanceof Error ? err.message : String(err));
      setZignerShieldStep('error');
    }
  }, [shieldUnsignedData, selectedKeyInfo, watchOnly, zidecarUrl]);

  // rescan state
  const [rescanOpen, setRescanOpen] = useState(false);
  const [rescanHeight, setRescanHeight] = useState('');
  const [rescanning, setRescanning] = useState(false);

  const handleRescan = useCallback(async () => {
    if (!selectedKeyInfo) return;
    if (!hasMnemonic && !watchOnly) return;
    const newHeight = parseInt(rescanHeight, 10);
    if (isNaN(newHeight) || newHeight < 0) return;

    setRescanning(true);
    try {
      const walletId = selectedKeyInfo.id;
      const birthdayKey = `zcashBirthday_${walletId}`;

      // stop active sync
      await stopSyncInWorker('zcash', walletId);
      // clear IDB data
      await resetSyncInWorker('zcash', walletId);
      // update birthday and clear persisted sync height
      await chrome.storage.local.set({ [birthdayKey]: newHeight });
      await chrome.storage.local.remove('zcashSyncHeight');
      setWalletBirthday(newHeight);
      // restart sync — mnemonic or watch-only
      if (hasMnemonic && selectedKeyInfo.type === 'mnemonic') {
        const mnemonic = await keyRing.getMnemonic(walletId);
        await startSyncInWorker('zcash', walletId, mnemonic, zidecarUrl, newHeight);
      } else {
        const ufvkStr = watchOnly?.ufvk ?? (watchOnly?.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
        if (ufvkStr) {
          await startWatchOnlySyncInWorker('zcash', walletId, ufvkStr, zidecarUrl, newHeight);
        }
      }

      setRescanOpen(false);
      setRescanHeight('');
    } catch (err) {
      console.error('[zcash] rescan failed:', err);
    } finally {
      setRescanning(false);
    }
  }, [hasMnemonic, watchOnly, selectedKeyInfo?.id, selectedKeyInfo?.type, keyRing, rescanHeight, zidecarUrl]);

  const handleShield = useCallback(async () => {
    if (!hasMnemonic || !selectedKeyInfo || selectedKeyInfo.type !== 'mnemonic') return;
    if (shielding || transparentZat <= 0n) return;

    setShielding(true);
    setShieldTxid(null);
    setShieldError(null);

    try {
      const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
      const walletId = selectedKeyInfo.id;
      // map each address to its BIP44 derivation index so the worker signs with the correct key
      const addressIndexMap: Record<string, number> = {};
      tAddresses.forEach((addr, i) => { addressIndexMap[addr] = i; });
      const result = await shieldInWorker(
        'zcash', walletId, mnemonic,
        zidecarUrl, tAddresses, isMainnet, addressIndexMap,
      );
      setShieldTxid(result.txid);
    } catch (err) {
      setShieldError(err instanceof Error ? err.message : String(err));
    } finally {
      setShielding(false);
    }
  }, [hasMnemonic, selectedKeyInfo, keyRing, shielding, transparentZat, tAddresses, isMainnet]);

  if (!hasWallet) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-center'>
        <div className='text-sm text-muted-foreground'>no zcash wallet</div>
        <div className='text-xs text-muted-foreground mt-1'>
          create a wallet or import a viewing key from zigner
        </div>
      </div>
    );
  }

  // sync progress
  const chainHeight = chainTip?.height ?? syncStatus?.currentHeight ?? 0;
  const gigaproofStatus = syncStatus?.gigaproofStatus ?? 0;
  const lastGigaproofHeight = syncStatus?.lastGigaproofHeight ?? 0;
  const blocksUntilReady = syncStatus?.blocksUntilReady ?? 1;

  const nomtPct = gigaproofStatus >= 1 ? 100 : 0;
  const ligeritoPct = gigaproofStatus >= 2
    ? (blocksUntilReady <= 0 ? 100 : Math.min(100, Math.round((1 - (chainHeight - lastGigaproofHeight) / Math.max(blocksUntilReady, 1)) * 100)))
    : gigaproofStatus === 1 ? 50 : 0;
  const scanRange = Math.max(1, chainHeight - walletBirthday);
  const scanProgress = Math.max(0, workerSyncHeight - walletBirthday);
  const scanPct = chainHeight > 0
    ? Math.min(100, Math.round((scanProgress / scanRange) * 100))
    : 0;

  const allSynced = scanPct >= 100 && ligeritoPct >= 100;

  // combined balance
  const totalZat = orchardZat + transparentZat;
  const totalZec = Number(totalZat) / 1e8;
  const tZec = Number(transparentZat) / 1e8;

  // sync status label
  const isSyncing = chainHeight > 0 && !allSynced;

  return (
    <div className='flex-1 flex flex-col gap-3'>
      {/* combined balance */}
      <div className='border border-border/40 bg-card p-4'>
        <div className='text-3xl font-semibold tabular-nums text-foreground'>
          {workerSyncHeight > 0 || totalZat > 0n
            ? `${totalZec.toFixed(8)} ZEC`
            : '— ZEC'}
        </div>
        <div className='mt-1 flex items-center gap-1.5 text-xs text-muted-foreground'>
          {/* pulsing dot — green when synced, amber when syncing */}
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              allSynced ? 'bg-green-500' : isSyncing ? 'bg-amber-500 animate-pulse' : 'bg-muted-foreground/30 animate-pulse'
            }`}
          />
          {allSynced
            ? <span>synced · block {workerSyncHeight.toLocaleString()}</span>
            : chainHeight > 0
              ? <span>syncing · {scanProgress.toLocaleString()} / {scanRange.toLocaleString()} · block {workerSyncHeight.toLocaleString()}</span>
              : <span>connecting...</span>
          }
        </div>
      </div>

      {/* transparent pool detail — only shown when transparent > 0 */}
      {transparentZat > 0n && (
        <div className='border border-amber-500/30 bg-card p-3'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-xs text-amber-500'>transparent</span>
              <span className='text-xs font-medium tabular-nums'>
                {utxoLoading ? '...' : `${tZec.toFixed(8)} ZEC`}
              </span>
            </div>
            {hasMnemonic ? (
              <button
                onClick={() => void handleShield()}
                disabled={shielding || !!shieldTxid}
                className='text-xs font-medium text-amber-500 hover:text-amber-400 transition-colors disabled:opacity-50'
              >
                {shielding ? 'shielding...' : shieldTxid ? 'pending...' : 'shield'}
              </button>
            ) : (
              <button
                onClick={() => void handleZignerShield()}
                disabled={zignerShieldStep !== 'idle' && zignerShieldStep !== 'error' && zignerShieldStep !== 'complete'}
                className='text-xs font-medium text-amber-500 hover:text-amber-400 transition-colors disabled:opacity-50'
              >
                {zignerShieldStep === 'building' ? 'building...' :
                 zignerShieldStep === 'broadcasting' ? 'broadcasting...' :
                 zignerShieldStep === 'complete' ? 'pending...' : 'shield via zigner'}
              </button>
            )}
          </div>
          {shieldTxid && (
            <div className='text-[10px] text-green-500 mt-1.5 font-mono'>
              shielded: {shieldTxid.slice(0, 16)}... (wait for confirmation)
            </div>
          )}
          {shieldError && (
            <div className='text-[10px] text-red-400 mt-1.5'>{shieldError}</div>
          )}

          {/* zigner shielding QR flow */}
          {zignerShieldStep === 'show_qr' && shieldSignRequestQr && (
            <div className='mt-3 flex flex-col items-center gap-2'>
              <QrDisplay
                data={shieldSignRequestQr}
                size={180}
                title='scan with zafu zigner'
                description='scan to sign shielding transaction'
              />
              <div className='flex gap-2 w-full'>
                <button
                  onClick={() => setZignerShieldStep('scanning')}
                  className='flex-1 text-xs font-medium bg-primary text-primary-foreground py-1.5 hover:bg-primary/90 transition-colors'
                >
                  scan signature
                </button>
                <button
                  onClick={() => { setZignerShieldStep('idle'); setShieldSignRequestQr(null); }}
                  className='text-xs text-muted-foreground hover:text-foreground px-2 transition-colors'
                >
                  cancel
                </button>
              </div>
            </div>
          )}

          {zignerShieldStep === 'scanning' && (
            <div className='mt-3'>
              <QrScanner
                onScan={(data) => void handleZignerShieldSigScanned(data)}
                onError={(err) => {
                  setZignerShieldError(err);
                  setZignerShieldStep('error');
                }}
                onClose={() => setZignerShieldStep('show_qr')}
                title='scan signature'
                description='point camera at zafu zigner signature qr'
              />
            </div>
          )}

          {zignerShieldStep === 'complete' && zignerShieldTxid && (
            <div className='text-[10px] text-green-500 mt-1.5 font-mono'>
              shielded: {zignerShieldTxid.slice(0, 16)}... (wait for confirmation)
            </div>
          )}
          {zignerShieldStep === 'error' && zignerShieldError && (
            <div className='text-[10px] text-red-400 mt-1.5'>
              {zignerShieldError}
              <button
                onClick={() => { setZignerShieldStep('idle'); setZignerShieldError(null); }}
                className='ml-2 underline'
              >
                dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {/* sync pipeline — hidden when fully synced */}
      {!allSynced && (
        <div className='border border-border/40 bg-card p-3'>
          <div className='text-xs font-medium mb-2'>zidecar sync</div>
          {syncError && (
            <div className='text-xs text-red-400 mb-2'>sync error: {syncError.message}</div>
          )}

          <div className='flex gap-3 mb-2 text-[10px]'>
            <div className='flex items-center gap-1'>
              <div className={`h-1.5 w-1.5 rounded-full ${nomtPct >= 100 ? 'bg-blue-500' : 'bg-muted-foreground/30'}`} />
              <span className={nomtPct >= 100 ? 'text-blue-500' : 'text-muted-foreground'}>nomt</span>
            </div>
            <div className='flex items-center gap-1'>
              <div className={`h-1.5 w-1.5 rounded-full ${gigaproofStatus >= 2 ? 'bg-amber-500' : gigaproofStatus === 1 ? 'bg-amber-500/50' : 'bg-muted-foreground/30'}`} />
              <span className={gigaproofStatus >= 1 ? 'text-amber-500' : 'text-muted-foreground'}>ligerito</span>
              {gigaproofStatus === 1 && <span className='text-muted-foreground'>(proving...)</span>}
              {gigaproofStatus >= 2 && blocksUntilReady > 0 && (
                <span className='text-muted-foreground'>({blocksUntilReady} to tip)</span>
              )}
            </div>
          </div>

          <div className='h-3 w-full overflow-hidden rounded-sm bg-muted'>
            <div
              className='h-full bg-green-500 transition-all duration-500 ease-out'
              style={{ width: `${Math.max(0, Math.min(100, scanPct))}%` }}
            />
          </div>

          <div className='mt-1.5 text-xs text-muted-foreground tabular-nums'>
            {chainHeight > 0
              ? `${scanProgress.toLocaleString()} / ${scanRange.toLocaleString()} blocks`
              : 'waiting for chain tip...'}
          </div>
        </div>
      )}

      {/* rescan from custom height */}
      {hasWallet && (
        <div className='border border-border/40 bg-card p-3'>
          {!rescanOpen ? (
            <button
              onClick={() => setRescanOpen(true)}
              className='text-xs text-muted-foreground hover:text-foreground transition-colors'
            >
              rescan from height...
            </button>
          ) : (
            <div className='flex flex-col gap-2'>
              <div className='text-xs text-muted-foreground'>
                enter block height to rescan from (clears local notes)
              </div>
              <div className='flex gap-2'>
                <input
                  type='number'
                  min={0}
                  value={rescanHeight}
                  onChange={e => setRescanHeight(e.target.value)}
                  placeholder={String(walletBirthday || 0)}
                  className='flex-1 bg-muted px-2 py-1 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 outline-none'
                />
                <button
                  onClick={() => void handleRescan()}
                  disabled={rescanning || !rescanHeight}
                  className='px-3 py-1 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors'
                >
                  {rescanning ? 'resetting...' : 'rescan'}
                </button>
                <button
                  onClick={() => { setRescanOpen(false); setRescanHeight(''); }}
                  disabled={rescanning}
                  className='px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors'
                >
                  cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** polkadot/kusama content */
const PolkadotContent = ({
  publicKey,
  relay = 'polkadot',
}: {
  publicKey?: string;
  relay?: 'polkadot' | 'kusama';
}) => {
  if (!publicKey) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-center'>
        <div className='text-sm text-muted-foreground'>no {relay} wallet</div>
        <div className='text-xs text-muted-foreground mt-1'>
          import a polkadot account to get started
        </div>
      </div>
    );
  }

  return (
    <div className='flex-1'>
      <Suspense fallback={<AssetListSkeleton rows={3} />}>
        <PolkadotAssets publicKey={publicKey} relay={relay} />
      </Suspense>
    </div>
  );
};

/** cosmos chain content - shows balances from public RPC */
const CosmosContent = ({ chainId }: { chainId: CosmosChainId }) => {
  const config = COSMOS_CHAINS[chainId];

  const { data: assetsData, isLoading, error } = useCosmosAssets(chainId, 0);

  if (error) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-center'>
        <div className='text-sm text-muted-foreground'>failed to load balances</div>
        <div className='text-xs text-muted-foreground mt-1'>{error instanceof Error ? error.message : 'unknown error'}</div>
      </div>
    );
  }

  if (!assetsData && !isLoading) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-center'>
        <div className='text-sm text-muted-foreground'>enable transparent balance fetching in privacy settings to view {config.name} balances</div>
      </div>
    );
  }

  return (
    <div className='flex-1'>
      <div className='mb-2 text-xs font-medium text-muted-foreground'>assets</div>
      {isLoading ? (
        <AssetListSkeleton rows={2} />
      ) : assetsData?.assets.length === 0 ? (
        <div className='border border-border bg-card p-4'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <div className='h-8 w-8 bg-muted flex items-center justify-center'>
                <span className='text-sm font-bold'>{config.symbol[0]}</span>
              </div>
              <div>
                <div className='text-sm font-medium'>{config.symbol}</div>
                <div className='text-xs text-muted-foreground'>{config.name}</div>
              </div>
            </div>
            <div className='text-right'>
              <div className='text-sm font-medium tabular-nums'>0 {config.symbol}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className='flex flex-col gap-1'>
          {assetsData?.assets.map(asset => (
            <div key={asset.denom} className='border border-border bg-card p-4'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <div className='h-8 w-8 bg-muted flex items-center justify-center'>
                    <span className='text-sm font-bold'>{asset.symbol[0]}</span>
                  </div>
                  <div>
                    <div className='text-sm font-medium'>{asset.symbol}</div>
                    <div className='text-xs text-muted-foreground truncate max-w-[120px]'>{asset.denom}</div>
                  </div>
                </div>
                <div className='text-right'>
                  <div className='text-sm font-medium tabular-nums'>{asset.formatted}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** placeholder for networks not yet implemented */
const NetworkPlaceholder = ({ network }: { network: NetworkType }) => (
  <div className='flex flex-col items-center justify-center py-8 text-center'>
    <div className='text-sm text-muted-foreground'>{network} support coming soon</div>
  </div>
);
