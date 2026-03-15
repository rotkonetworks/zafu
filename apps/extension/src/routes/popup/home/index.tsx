import { lazy, Suspense, useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpIcon, ArrowDownIcon, CopyIcon, CheckIcon, ReloadIcon, ClockIcon, WidthIcon, ChevronDownIcon, MixIcon } from '@radix-ui/react-icons';

import { useStore } from '../../../state';
import { selectActiveNetwork, selectEffectiveKeyInfo, selectPenumbraAccount, selectSetPenumbraAccount, keyRingSelector, type NetworkType } from '../../../state/keyring';
import { PenumbraAccountPicker } from '../../../components/penumbra-account-picker';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
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
import { useQuery } from '@tanstack/react-query';
import { viewClient, sctClient } from '../../../clients';
import { getHistoryInWorker } from '../../../state/keyring/network-worker';
import { cn } from '@repo/ui/lib/utils';
import { messagesSelector } from '../../../state/messages';
import { SyncProgressBar } from '../../../components/sync-progress-bar';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import type { TransactionInfo } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

/** lazy load network-specific content - only load when needed */
const AssetsTable = lazy(() => import('./assets-table').then(m => ({ default: m.AssetsTable })));
const PolkadotAssets = lazy(() => import('./polkadot-assets').then(m => ({ default: m.PolkadotAssets })));

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
  const navigate = useNavigate();

  // check if we're in side panel or dedicated window (can navigate normally)
  // preload balances in background for instant display
  usePreloadBalances(penumbraAccount);


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
        <div className='flex items-center justify-between rounded-lg border border-border/40 bg-card p-4'>
          <div>
            <div className='flex items-center gap-1'>
              <button
                onClick={copyAddress}
                disabled={!address}
                className='flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-100 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed'
              >
                <span className='font-mono'>{displayAddress}</span>
                {address && (copied ? <CheckIcon className='h-3 w-3' /> : <CopyIcon className='h-3 w-3' />)}
              </button>
              {address && activeNetwork === 'zcash' && (
                <button
                  onClick={() => {
                    chrome.storage.local.get('zcashShieldedIndex', r => {
                      const next = ((r['zcashShieldedIndex'] as number) ?? 0) + 1;
                      void chrome.storage.local.set({ zcashShieldedIndex: next });
                    });
                  }}
                  className='p-0.5 text-muted-foreground transition-colors hover:text-foreground'
                  title='rotate address'
                >
                  <ReloadIcon className='h-3 w-3' />
                </button>
              )}
            </div>
          </div>

          <div className='flex gap-2'>
            <button
              onClick={() => navigate(PopupPath.RECEIVE)}
              className='flex h-10 w-10 items-center justify-center bg-muted transition-all duration-100 hover:bg-muted/80 active:scale-95'
              title='receive'
            >
              <ArrowDownIcon className='h-5 w-5' />
            </button>
            <button
              onClick={() => navigate(PopupPath.SWAP)}
              className='flex h-10 w-10 items-center justify-center bg-muted transition-all duration-100 hover:bg-muted/80 active:scale-95'
              title='swap'
            >
              <MixIcon className='h-5 w-5' />
            </button>
            <button
              onClick={() => navigate(PopupPath.SEND)}
              className={cn(
                'flex h-10 w-10 items-center justify-center transition-all duration-100 active:scale-95',
                activeNetwork === 'penumbra'
                  ? 'bg-penumbra-purple text-white hover:bg-penumbra-purple-dark'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90',
              )}
              title='send'
            >
              <ArrowUpIcon className='h-5 w-5' />
            </button>
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

        {/* recent history */}
        <Suspense fallback={<AssetListSkeleton rows={3} />}>
          <HistoryContent network={activeNetwork} />
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
      return <PenumbraContent account={penumbraAccount} />;

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

/** penumbra-specific content — balance card + sync bar + assets */
const PenumbraContent = ({ account }: { account: number }) => {
  const { latestBlockHeight, fullSyncHeight, error } = useSyncProgress();

  const isSyncing = (latestBlockHeight ?? 0) - (fullSyncHeight ?? 0) > 10;
  const syncPct = latestBlockHeight && fullSyncHeight
    ? Math.min(100, Math.round((Number(fullSyncHeight) / Number(latestBlockHeight)) * 100))
    : 0;

  const syncLabel = !latestBlockHeight
    ? 'connecting...'
    : isSyncing
      ? `syncing · block ${(fullSyncHeight ?? 0).toLocaleString()} / ${latestBlockHeight.toLocaleString()}`
      : `block ${(fullSyncHeight ?? latestBlockHeight).toLocaleString()}`;

  return (
    <div className='flex-1 flex flex-col gap-3'>
      {/* balance card */}
      <div className='rounded-lg border border-penumbra-purple/20 bg-card p-4'>
        <div className='text-xs text-muted-foreground'>balance</div>
        <div className='text-3xl font-semibold tabular-nums text-foreground'>
          {fullSyncHeight ? '—' : '—'} UM
        </div>
        <div className='mt-1 text-xs text-muted-foreground'>{syncLabel}</div>
      </div>

      {/* sync bar — hidden when synced */}
      {isSyncing && (
        <SyncProgressBar
          percent={syncPct}
          label={syncLabel}
          error={error ? String(error) : undefined}
          barColor='bg-penumbra-purple'
          barDoneColor='bg-penumbra-teal'
        />
      )}

      <div className='mb-2 text-xs font-medium text-muted-foreground'>assets</div>
      <Suspense fallback={<AssetListSkeleton rows={4} />}>
        <AssetsTable account={account} />
      </Suspense>
    </div>
  );
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

  // rescan via custom event from HistoryContent
  useEffect(() => {
    const handler = async (e: Event) => {
      const height = (e as CustomEvent<number>).detail;
      if (!selectedKeyInfo || (!hasMnemonic && !watchOnly)) return;
      if (isNaN(height) || height < 0) return;

      try {
        const walletId = selectedKeyInfo.id;
        const birthdayKey = `zcashBirthday_${walletId}`;

        await stopSyncInWorker('zcash', walletId);
        await resetSyncInWorker('zcash', walletId);
        await chrome.storage.local.set({ [birthdayKey]: height });
        await chrome.storage.local.remove('zcashSyncHeight');
        setWalletBirthday(height);

        if (hasMnemonic && selectedKeyInfo.type === 'mnemonic') {
          const mnemonic = await keyRing.getMnemonic(walletId);
          await startSyncInWorker('zcash', walletId, mnemonic, zidecarUrl, height);
        } else {
          const ufvkStr = watchOnly?.ufvk ?? (watchOnly?.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
          if (ufvkStr) {
            await startWatchOnlySyncInWorker('zcash', walletId, ufvkStr, zidecarUrl, height);
          }
        }
      } catch (err) {
        console.error('[zcash] rescan failed:', err);
      }
    };
    window.addEventListener('zcash-rescan', handler);
    return () => window.removeEventListener('zcash-rescan', handler);
  }, [hasMnemonic, watchOnly, selectedKeyInfo?.id, selectedKeyInfo?.type, keyRing, zidecarUrl]);

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

  return (
    <div className='flex-1 flex flex-col gap-3'>
      {/* combined balance */}
      <div className='rounded-lg border border-primary/20 bg-card p-4'>
        <div className='text-xs text-muted-foreground'>balance</div>
        <div className='text-3xl font-semibold tabular-nums text-foreground'>
          {workerSyncHeight > 0 || totalZat > 0n
            ? `${totalZec.toFixed(8)} ZEC`
            : '— ZEC'}
        </div>
        <div className='mt-1 text-xs text-muted-foreground'>
          {chainHeight <= 0
            ? 'connecting...'
            : scanPct >= 100
              ? `block ${workerSyncHeight.toLocaleString()}`
              : `syncing · block ${workerSyncHeight.toLocaleString()}`}
        </div>
      </div>

      {/* transparent pool detail — only shown when transparent > 0 */}
      {transparentZat > 0n && (
        <div className='rounded-lg border border-red-500/30 bg-red-500/5 p-3'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-xs text-red-500'>transparent</span>
              <span className='text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-500 font-medium leading-none'>public</span>
              <span className='text-xs font-medium tabular-nums'>
                {utxoLoading ? '...' : `${tZec.toFixed(8)} ZEC`}
              </span>
            </div>
            {hasMnemonic ? (
              <button
                onClick={() => void handleShield()}
                disabled={shielding || !!shieldTxid}
                className='text-xs font-medium text-red-500 hover:text-red-400 transition-colors disabled:opacity-50'
              >
                {shielding ? 'shielding...' : shieldTxid ? 'pending...' : 'shield'}
              </button>
            ) : (
              <button
                onClick={() => void handleZignerShield()}
                disabled={zignerShieldStep !== 'idle' && zignerShieldStep !== 'error' && zignerShieldStep !== 'complete'}
                className='text-xs font-medium text-red-500 hover:text-red-400 transition-colors disabled:opacity-50'
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
        <SyncProgressBar
          percent={Math.max(scanPct > 0 ? scanPct : ligeritoPct > 0 ? ligeritoPct : nomtPct, 2)}
          label={chainHeight <= 0
            ? 'connecting...'
            : scanPct > 0
              ? `scanning ${scanProgress.toLocaleString()} / ${scanRange.toLocaleString()}`
              : gigaproofStatus >= 2
                ? blocksUntilReady > 0 ? `ligerito ${blocksUntilReady} blocks to tip` : 'ligerito verified'
                : gigaproofStatus === 1
                  ? 'ligerito proving...'
                  : nomtPct >= 100
                    ? 'nomt verified, waiting for ligerito'
                    : 'verifying nomt...'}
          error={syncError?.message}
          barColor={scanPct > 0 ? 'bg-green-500' : ligeritoPct > 0 ? 'bg-primary' : 'bg-muted-foreground/30'}
          barDoneColor='bg-green-500'
        />
      )}

      {/* rescan is now in the recent activity header */}
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
        <div className='rounded-lg border border-border bg-card p-4'>
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
            <div key={asset.denom} className='rounded-lg border border-border bg-card p-4'>
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

// ── history ──

interface ParsedTransaction {
  id: string;
  height: number;
  timestamp: number | null;
  type: 'send' | 'receive' | 'shield' | 'swap' | 'delegate' | 'undelegate' | 'unknown';
  description: string;
  amount?: string;
  asset?: string;
  memo?: string;
}

function parsePenumbraTx(txInfo: TransactionInfo): ParsedTransaction {
  const id = txInfo.id?.inner
    ? Array.from(txInfo.id.inner).map(b => b.toString(16).padStart(2, '0')).join('')
    : '';
  const height = Number(txInfo.height ?? 0);
  let type: ParsedTransaction['type'] = 'unknown';
  let description = 'Transaction';
  let hasVisibleSpend = false;
  let hasOutput = false;

  for (const action of txInfo.view?.bodyView?.actionViews ?? []) {
    const c = action.actionView.case;
    if (c === 'spend' && action.actionView.value.spendView?.case === 'visible') hasVisibleSpend = true;
    else if (c === 'output') hasOutput = true;
    else if (c === 'swap') { type = 'swap'; description = 'Swap'; }
    else if (c === 'delegate') { type = 'delegate'; description = 'Delegate'; }
    else if (c === 'undelegate') { type = 'undelegate'; description = 'Undelegate'; }
  }
  if (type === 'unknown') {
    if (hasVisibleSpend) { type = 'send'; description = 'Send'; }
    else if (hasOutput) { type = 'receive'; description = 'Receive'; }
  }

  // extract memo text if visible
  let memo: string | undefined;
  const memoView = txInfo.view?.bodyView?.memoView?.memoView;
  if (memoView?.case === 'visible' && memoView.value.plaintext?.text) {
    const text = memoView.value.plaintext.text.trim();
    if (text) memo = text;
  }

  return { id, height, timestamp: null, type, description, memo };
}

function zatToZec(zat: bigint | string): string {
  const v = typeof zat === 'string' ? BigInt(zat) : zat;
  const w = v / 100_000_000n;
  const f = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${w}.${f}`;
}

function fmtTime(ts: number | null): string {
  if (ts === null) return '...';
  const d = new Date(ts);
  const now = new Date();
  const diff = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `Today ${t}`;
  if (diff === 1) return `Yesterday ${t}`;
  if (diff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

function TxRow({ tx }: { tx: ParsedTransaction }) {
  const [expanded, setExpanded] = useState(false);
  const isIn = tx.type === 'receive';
  const isSh = tx.type === 'shield';
  const hasMemo = !!tx.memo;

  return (
    <div
      className={cn(
        'rounded-lg border border-border/30 bg-card p-3 transition-colors',
        hasMemo ? 'cursor-pointer hover:border-border' : '',
      )}
      onClick={hasMemo ? () => setExpanded(e => !e) : undefined}
    >
      <div className='flex items-center gap-3'>
        <div className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full',
          isSh ? 'bg-blue-500/10' : isIn ? 'bg-green-500/10' : 'bg-muted/50',
        )}>
          {isSh ? <WidthIcon className='h-4 w-4 text-blue-500' />
            : isIn ? <ArrowDownIcon className='h-4 w-4 text-green-500' />
            : <ArrowUpIcon className='h-4 w-4 text-muted-foreground' />}
        </div>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-xs font-medium'>{tx.description}</span>
            <div className='flex items-center gap-1'>
              {tx.amount && (
                <span className={cn('text-xs font-mono',
                  isSh ? 'text-blue-500' : isIn ? 'text-green-500' : 'text-muted-foreground',
                )}>
                  {isIn ? '+' : ''}{tx.amount} {tx.asset ?? ''}
                </span>
              )}
              {hasMemo && (
                <ChevronDownIcon className={cn(
                  'h-3 w-3 text-muted-foreground transition-transform',
                  expanded && 'rotate-180',
                )} />
              )}
            </div>
          </div>
          <div className='flex items-center justify-between gap-2 mt-0.5'>
            <span className='text-[10px] text-muted-foreground font-mono truncate'>{tx.id.slice(0, 16)}...</span>
            <span className='text-[10px] text-muted-foreground whitespace-nowrap'>
              {tx.height > 0 ? `#${tx.height}` : fmtTime(tx.timestamp)}
            </span>
          </div>
        </div>
      </div>
      {expanded && tx.memo && (
        <div className='mt-2 ml-11 border-l-2 border-border/40 pl-3'>
          <p className='text-xs text-muted-foreground whitespace-pre-wrap break-words'>{tx.memo}</p>
        </div>
      )}
    </div>
  );
}

const HistoryContent = ({ network }: { network: NetworkType }) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const messages = useStore(messagesSelector);
  const walletId = selectedKeyInfo?.id;
  const isMainnet = !zidecarUrl.includes('testnet');
  const { tAddresses } = useTransparentAddresses(isMainnet);
  const { workerSyncHeight } = useZcashSyncStatus();

  // editable start block for zcash rescan
  const [editingStart, setEditingStart] = useState(false);
  const [startBlockInput, setStartBlockInput] = useState('');
  const [walletBirthday, setWalletBirthday] = useState(0);

  useEffect(() => {
    if (network !== 'zcash' || !walletId) return;
    const key = `zcashBirthday_${walletId}`;
    chrome.storage.local.get(key, r => {
      if (typeof r[key] === 'number') setWalletBirthday(r[key] as number);
    });
  }, [network, walletId]);

  // build txId→memo lookup from messages store (for zcash)
  const memoByTxId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages.getByNetwork(network as 'zcash' | 'penumbra')) {
      if (m.content) map.set(m.txId, m.content);
    }
    return map;
  }, [messages, network]);

  const penumbraQ = useQuery({
    queryKey: ['homeHistory', 'penumbra'],
    enabled: network === 'penumbra',
    staleTime: 30_000,
    queryFn: async () => {
      const txs: ParsedTransaction[] = [];
      for await (const r of viewClient.transactionInfo({})) {
        if (r.txInfo) txs.push(parsePenumbraTx(r.txInfo));
      }
      const heights = [...new Set(txs.map(t => t.height))];
      const tsMap = new Map<number, number>();
      await Promise.all(heights.map(async h => {
        try {
          const { timestamp } = await sctClient.timestampByHeight({ height: BigInt(h) });
          if (timestamp) tsMap.set(h, timestamp.toDate().getTime());
        } catch { /* */ }
      }));
      for (const t of txs) t.timestamp = tsMap.get(t.height) ?? null;
      txs.sort((a, b) => b.height - a.height);
      return txs;
    },
  });

  const zcashQ = useQuery({
    queryKey: ['homeHistory', 'zcash', walletId, tAddresses.length],
    enabled: network === 'zcash' && !!walletId,
    staleTime: 0,
    queryFn: async () => {
      if (!walletId) return [];
      const entries = await getHistoryInWorker('zcash', walletId, zidecarUrl, tAddresses);
      return entries.map(e => ({
        id: e.id,
        height: e.height,
        timestamp: null,
        type: e.type as ParsedTransaction['type'],
        description: e.type === 'send' ? 'Sent' : e.type === 'shield' ? 'Shielded' : 'Received',
        amount: zatToZec(BigInt(e.amount)),
        asset: e.asset,
        memo: memoByTxId.get(e.id),
      }));
    },
  });

  const q = network === 'penumbra' ? penumbraQ : zcashQ;
  const txs = q.data ?? [];

  if (q.isLoading && txs.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-2 py-8'>
        <ReloadIcon className='h-5 w-5 animate-spin text-muted-foreground' />
        <span className='text-xs text-muted-foreground'>loading...</span>
      </div>
    );
  }

  if (q.error) {
    return (
      <div className='flex flex-col items-center justify-center gap-2 py-8'>
        <span className='text-xs text-red-400'>failed to load</span>
        <button onClick={() => void q.refetch()} className='text-xs text-primary hover:underline'>retry</button>
      </div>
    );
  }

  if (txs.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-2 py-4'>
        <ClockIcon className='h-5 w-5 text-muted-foreground' />
        <span className='text-xs text-muted-foreground'>no transactions yet</span>
      </div>
    );
  }

  const recent = txs.slice(0, 20);

  return (
    <div className='flex flex-col gap-1'>
      <div className='mb-1 flex items-center justify-between'>
        <span className='text-xs font-medium text-muted-foreground'>recent activity</span>
        {network === 'zcash' && (
          <div className='flex items-center gap-1.5'>
            {editingStart ? (
              <div className='flex items-center gap-1'>
                <input
                  type='number'
                  min={0}
                  value={startBlockInput}
                  onChange={e => setStartBlockInput(e.target.value)}
                  placeholder={String(walletBirthday)}
                  className='w-20 bg-muted px-1.5 py-0.5 text-[10px] font-mono text-foreground placeholder:text-muted-foreground/50 outline-none'
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter' && startBlockInput) {
                      window.dispatchEvent(new CustomEvent('zcash-rescan', { detail: parseInt(startBlockInput, 10) }));
                      setEditingStart(false);
                      setStartBlockInput('');
                    } else if (e.key === 'Escape') {
                      setEditingStart(false);
                      setStartBlockInput('');
                    }
                  }}
                />
                <button
                  onClick={() => {
                    if (startBlockInput) {
                      window.dispatchEvent(new CustomEvent('zcash-rescan', { detail: parseInt(startBlockInput, 10) }));
                    }
                    setEditingStart(false);
                    setStartBlockInput('');
                  }}
                  className='text-[10px] text-primary hover:underline'
                >
                  go
                </button>
                <button
                  onClick={() => { setEditingStart(false); setStartBlockInput(''); }}
                  className='text-[10px] text-muted-foreground hover:text-foreground'
                >
                  &times;
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setEditingStart(true); setStartBlockInput(String(walletBirthday)); }}
                className='text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors'
                title='click to change start block'
              >
                {walletBirthday > 0 ? walletBirthday.toLocaleString() : '0'}..{workerSyncHeight > 0 ? workerSyncHeight.toLocaleString() : '?'}
              </button>
            )}
          </div>
        )}
      </div>
      {recent.map(tx => <TxRow key={tx.id} tx={tx} />)}
      {txs.length > 20 && (
        <div className='py-2 text-center text-xs text-muted-foreground'>
          {txs.length - 20} more transactions
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
