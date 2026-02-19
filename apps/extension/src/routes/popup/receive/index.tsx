/**
 * receive screen - show QR code for current address
 *
 * for penumbra: supports IBC deposit from zafu's own cosmos wallets
 * - select source chain (Noble, Osmosis, etc.)
 * - shows zafu's address + balances on that chain
 * - pick asset + amount, shield into penumbra via IBC
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, CopyIcon, CheckIcon, InfoCircledIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectEffectiveKeyInfo, keyRingSelector } from '../../../state/keyring';
import { getActiveWalletJson } from '../../../state/wallets';
import { useActiveAddress } from '../../../hooks/use-address';
import {
  derivePenumbraEphemeralFromMnemonic,
  derivePenumbraEphemeralFromFvk,
} from '../../../hooks/use-address';
import { useIbcChains, type IbcChain } from '../../../hooks/ibc-chains';
import { useCosmosAssets, type CosmosAsset } from '../../../hooks/cosmos-balance';
import { useCosmosIbcTransfer } from '../../../hooks/cosmos-signer';
import { type CosmosChainId, COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import QRCode from 'qrcode';

/** small copy button with feedback */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return (
    <button
      onClick={copy}
      className={className ?? 'shrink-0 text-muted-foreground transition-colors duration-75 hover:text-foreground'}
    >
      {copied ? <CheckIcon className='h-4 w-4' /> : <CopyIcon className='h-4 w-4' />}
    </button>
  );
}

/** map IBC chain registry chainId to our CosmosChainId */
function ibcChainToCosmosId(ibcChain: IbcChain): CosmosChainId | undefined {
  const map: Record<string, CosmosChainId> = {
    'osmosis-1': 'osmosis',
    'noble-1': 'noble',
    'nomic-stakenet-3': 'nomic',
    'celestia': 'celestia',
  };
  return map[ibcChain.chainId];
}

/**
 * Build IbcChain entries from our own COSMOS_CHAINS config.
 * Used as fallback when the penumbra registry doesn't list these chains.
 */
function getKnownIbcChains(): IbcChain[] {
  return Object.values(COSMOS_CHAINS)
    .filter(c => c.penumbraChannel) // only chains with known penumbra channel
    .map(c => ({
      displayName: c.name,
      chainId: c.chainId,
      channelId: '', // penumbra-side channel (not needed for deposit)
      counterpartyChannelId: c.penumbraChannel!, // cosmos-side channel to penumbra
      addressPrefix: c.bech32Prefix,
      images: [],
    }));
}

/** merge registry chains with our known chains (dedup by chainId) */
function mergeIbcChains(registryChains: IbcChain[]): IbcChain[] {
  const known = getKnownIbcChains();
  const seen = new Set(registryChains.map(c => c.chainId));
  // add any known chains not already in the registry
  for (const chain of known) {
    if (!seen.has(chain.chainId)) {
      registryChains.push(chain);
    }
  }
  // filter to only chains we have a CosmosChainId mapping for
  return registryChains.filter(c => ibcChainToCosmosId(c) !== undefined);
}

/** IBC deposit section - shield assets from cosmos into penumbra */
function IbcDepositSection({ selectedKeyInfo, keyRing, penumbraWallet }: {
  selectedKeyInfo: { type: string; id: string } | undefined;
  keyRing: { getMnemonic: (id: string) => Promise<string> };
  penumbraWallet: { fullViewingKey?: string } | undefined;
}) {
  const { data: registryChains = [], isLoading: chainsLoading } = useIbcChains();
  const ibcChains = mergeIbcChains([...registryChains]);
  const [selectedIbcChain, setSelectedIbcChain] = useState<IbcChain | undefined>();
  const [showChainDropdown, setShowChainDropdown] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<CosmosAsset | undefined>();
  const [showAssetDropdown, setShowAssetDropdown] = useState(false);
  const [amount, setAmount] = useState('');
  const [depositAddress, setDepositAddress] = useState('');
  const [txStatus, setTxStatus] = useState<'idle' | 'signing' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState('');
  const [txError, setTxError] = useState('');

  // map selected IBC chain to cosmos chain ID
  const cosmosChainId = selectedIbcChain ? ibcChainToCosmosId(selectedIbcChain) : undefined;

  // fetch balances on selected chain
  const { data: assetsData, isLoading: assetsLoading } = useCosmosAssets(
    cosmosChainId ?? 'osmosis',
    0,
  );
  const assetsEnabled = !!cosmosChainId;

  const cosmosIbc = useCosmosIbcTransfer();

  // generate ephemeral deposit address when chain is selected
  useEffect(() => {
    if (!selectedIbcChain) return;

    let cancelled = false;
    setDepositAddress('');

    const generate = async () => {
      try {
        let addr: string;
        if (selectedKeyInfo?.type === 'mnemonic') {
          const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
          addr = await derivePenumbraEphemeralFromMnemonic(mnemonic, 0);
        } else if (penumbraWallet?.fullViewingKey) {
          addr = await derivePenumbraEphemeralFromFvk(penumbraWallet.fullViewingKey, 0);
        } else {
          return;
        }
        if (!cancelled) {
          setDepositAddress(addr);
        }
      } catch (err) {
        console.error('failed to generate deposit address:', err);
      }
    };

    void generate();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIbcChain]);

  // reset asset when chain changes
  useEffect(() => {
    setSelectedAsset(undefined);
    setAmount('');
    setTxStatus('idle');
    setTxHash('');
    setTxError('');
  }, [selectedIbcChain]);

  const canSubmit = selectedIbcChain && selectedAsset && amount && parseFloat(amount) > 0
    && depositAddress && cosmosChainId && txStatus === 'idle';

  const handleShield = useCallback(async () => {
    if (!canSubmit || !selectedIbcChain || !selectedAsset || !cosmosChainId) return;

    setTxStatus('signing');
    setTxError('');

    try {
      const result = await cosmosIbc.mutateAsync({
        sourceChainId: cosmosChainId,
        destChainId: 'penumbra-1',
        sourceChannel: selectedIbcChain.counterpartyChannelId,
        toAddress: depositAddress,
        amount,
        denom: selectedAsset.denom,
      });

      setTxStatus('success');
      setTxHash(result.txHash);
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'transaction failed');
    }
  }, [canSubmit, selectedIbcChain, selectedAsset, cosmosChainId, depositAddress, amount, cosmosIbc]);

  const handleReset = useCallback(() => {
    setTxStatus('idle');
    setTxHash('');
    setTxError('');
    setAmount('');
  }, []);

  return (
    <div className='w-full border-t border-border/40 pt-4'>
      <div className='mb-3 text-sm font-medium'>Shield Assets via IBC</div>

      {/* source chain selector */}
      <div className='mb-3'>
        <div className='mb-1 text-xs text-muted-foreground'>source chain</div>
        <div className='relative'>
          <button
            onClick={() => setShowChainDropdown(prev => !prev)}
            disabled={chainsLoading}
            className='flex w-full items-center justify-between rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground transition-colors duration-100 hover:border-zigner-gold disabled:opacity-50'
          >
            <span>{selectedIbcChain?.displayName ?? (chainsLoading ? 'loading...' : 'select source chain')}</span>
            <ChevronDownIcon className='h-4 w-4 text-muted-foreground' />
          </button>
          {showChainDropdown && (
            <div className='absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-lg'>
              {ibcChains.map(chain => (
                <button
                  key={chain.chainId}
                  onClick={() => {
                    setSelectedIbcChain(chain);
                    setShowChainDropdown(false);
                  }}
                  className='flex w-full items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted/50 first:rounded-t-lg last:rounded-b-lg'
                >
                  {chain.images[0]?.svg || chain.images[0]?.png ? (
                    <img src={chain.images[0].svg ?? chain.images[0].png} className='h-4 w-4' alt='' />
                  ) : (
                    <span className='h-4 w-4 rounded-full bg-muted' />
                  )}
                  {chain.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* wallet info + balances when chain is selected */}
      {selectedIbcChain && cosmosChainId && (
        <>
          {/* wallet address on source chain */}
          <div className='mb-3'>
            <div className='mb-1 text-xs text-muted-foreground'>
              your wallet on {selectedIbcChain.displayName}
            </div>
            <div className='flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 p-3'>
              <code className='flex-1 break-all text-xs'>
                {assetsData?.address ?? 'loading...'}
              </code>
              {assetsData?.address && <CopyButton text={assetsData.address} />}
            </div>
          </div>

          {/* balances */}
          <div className='mb-3'>
            <div className='mb-1 text-xs text-muted-foreground'>
              balances on {selectedIbcChain.displayName}
            </div>
            {!assetsEnabled ? (
              <p className='text-xs text-muted-foreground'>enable transparent balance fetching in settings</p>
            ) : assetsLoading ? (
              <div className='rounded-lg border border-border/40 bg-muted/30 p-3'>
                <span className='text-xs text-muted-foreground'>loading balances...</span>
              </div>
            ) : assetsData?.assets.length === 0 ? (
              <div className='rounded-lg border border-border/40 bg-muted/30 p-3'>
                <span className='text-xs text-muted-foreground'>no assets found</span>
              </div>
            ) : (
              <div className='rounded-lg border border-border/40 bg-muted/10'>
                {assetsData?.assets.map(asset => (
                  <div key={asset.denom} className='flex items-center justify-between px-3 py-2 text-xs border-b border-border/20 last:border-0'>
                    <span className='text-muted-foreground truncate max-w-[60%]'>
                      {asset.symbol}
                    </span>
                    <span className='font-mono'>{asset.formatted}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* shielding transfer form */}
          <div className='mb-3'>
            <div className='mb-2 text-xs font-medium'>Initiate Shielding Transfer</div>
            <div className='flex gap-2'>
              {/* asset selector */}
              <div className='relative flex-1'>
                <button
                  onClick={() => setShowAssetDropdown(prev => !prev)}
                  disabled={!assetsData?.assets.length}
                  className='flex w-full items-center justify-between rounded-lg border border-border bg-input px-3 py-2 text-xs disabled:opacity-50'
                >
                  <span>{selectedAsset?.symbol ?? 'select asset'}</span>
                  <ChevronDownIcon className='h-3 w-3 text-muted-foreground' />
                </button>
                {showAssetDropdown && assetsData?.assets && (
                  <div className='absolute left-0 top-full z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-lg'>
                    {assetsData.assets.map(asset => (
                      <button
                        key={asset.denom}
                        onClick={() => {
                          setSelectedAsset(asset);
                          setShowAssetDropdown(false);
                        }}
                        className='flex w-full items-center justify-between px-3 py-2 text-xs hover:bg-muted/50 first:rounded-t-lg last:rounded-b-lg'
                      >
                        <span>{asset.symbol}</span>
                        <span className='text-muted-foreground'>{asset.formatted}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* amount input */}
              <input
                type='text'
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder='amount'
                disabled={txStatus !== 'idle'}
                className='flex-1 rounded-lg border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-zigner-gold focus:outline-none disabled:opacity-50'
              />
            </div>
          </div>

          {/* deposit address info */}
          <div className='mb-3'>
            <div className='mb-1 flex items-center gap-1.5 text-xs text-muted-foreground'>
              <span>sending to</span>
              <span className='font-medium text-foreground'>Main Account</span>
            </div>
            <p className='text-xs text-muted-foreground'>
              The deposit will be made to a freshly generated address belonging to you.{' '}
              {depositAddress && (
                <button
                  onClick={() => navigator.clipboard.writeText(depositAddress)}
                  className='text-foreground underline'
                >
                  Copy address
                </button>
              )}
            </p>
          </div>

          {/* transaction status */}
          {txStatus === 'success' && (
            <div className='mb-3 rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
              <p className='text-sm text-green-400'>shielding transfer sent!</p>
              <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>{txHash}</p>
              <button onClick={handleReset} className='mt-2 text-xs text-green-400 underline'>
                send another
              </button>
            </div>
          )}

          {txStatus === 'error' && (
            <div className='mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
              <p className='text-sm text-red-400'>transaction failed</p>
              <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
              <button onClick={handleReset} className='mt-2 text-xs text-red-400 underline'>
                retry
              </button>
            </div>
          )}

          {/* shield button */}
          {txStatus !== 'success' && (
            <button
              onClick={handleShield}
              disabled={!canSubmit}
              className='w-full rounded-lg bg-zigner-gold px-4 py-3 text-sm font-medium text-zigner-dark transition-colors duration-100 hover:bg-zigner-gold/90 disabled:opacity-50'
            >
              {txStatus === 'signing' ? 'shielding...' : 'Shield Assets'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function ReceivePage() {
  const navigate = useNavigate();
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyRing = useStore(keyRingSelector);
  const penumbraWallet = useStore(getActiveWalletJson);

  const { address, loading } = useActiveAddress();
  const [copied, setCopied] = useState(false);
  const [ibcDeposit, setIbcDeposit] = useState(false);
  const [ephemeralAddress, setEphemeralAddress] = useState<string>('');
  const [ephemeralLoading, setEphemeralLoading] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const isPenumbra = activeNetwork === 'penumbra';
  const displayAddress = ibcDeposit && ephemeralAddress ? ephemeralAddress : address;
  const isLoading = ibcDeposit ? ephemeralLoading : loading;

  // generate QR code for whichever address is active
  useEffect(() => {
    if (canvasRef.current && displayAddress) {
      QRCode.toCanvas(canvasRef.current, displayAddress, {
        width: 192,
        margin: 2,
        color: { dark: '#000', light: '#fff' },
      });
    }
  }, [displayAddress]);

  // generate ephemeral address when toggle is turned ON
  useEffect(() => {
    if (!ibcDeposit || !isPenumbra) return;

    let cancelled = false;
    setEphemeralLoading(true);

    const generate = async () => {
      try {
        let addr: string;
        if (selectedKeyInfo?.type === 'mnemonic') {
          const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
          addr = await derivePenumbraEphemeralFromMnemonic(mnemonic, 0);
        } else if (penumbraWallet?.fullViewingKey) {
          addr = await derivePenumbraEphemeralFromFvk(penumbraWallet.fullViewingKey, 0);
        } else {
          return;
        }
        if (!cancelled) {
          setEphemeralAddress(addr);
          setEphemeralLoading(false);
        }
      } catch (err) {
        console.error('failed to generate ephemeral address:', err);
        if (!cancelled) setEphemeralLoading(false);
      }
    };

    void generate();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ibcDeposit]);

  const copyAddress = useCallback(async () => {
    if (!displayAddress) return;
    await navigator.clipboard.writeText(displayAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [displayAddress]);

  // reset ephemeral state when toggling off
  const handleToggle = useCallback(() => {
    setIbcDeposit(prev => {
      if (prev) setEphemeralAddress('');
      return !prev;
    });
    setCopied(false);
  }, []);

  return (
    <div className='flex h-full flex-col'>
      <div className='flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-3'>
        <button
          onClick={() => navigate(PopupPath.INDEX)}
          className='text-muted-foreground transition-colors duration-75 hover:text-foreground'
        >
          <ArrowLeftIcon className='h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium text-foreground'>receive</h1>
      </div>

      <div className='flex flex-1 flex-col items-center gap-4 overflow-y-auto p-6'>
        <div className='rounded-xl border border-border bg-white p-2'>
          {isLoading ? (
            <div className='flex h-48 w-48 items-center justify-center'>
              <span className='text-xs text-muted-foreground'>loading...</span>
            </div>
          ) : displayAddress ? (
            <canvas ref={canvasRef} className='h-48 w-48' />
          ) : (
            <div className='flex h-48 w-48 items-center justify-center'>
              <span className='text-xs text-muted-foreground'>no wallet</span>
            </div>
          )}
        </div>

        <span className='rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize'>
          {activeNetwork}
        </span>

        {/* IBC Deposit Address toggle - Penumbra only */}
        {isPenumbra && (
          <div className='flex w-full items-center justify-between'>
            <div className='flex items-center gap-1.5'>
              <span className='text-sm font-medium'>IBC Deposit Address</span>
              <div className='relative'>
                <button
                  onClick={() => setShowTooltip(prev => !prev)}
                  className='text-muted-foreground transition-colors duration-75 hover:text-foreground'
                >
                  <InfoCircledIcon className='h-3.5 w-3.5' />
                </button>
                {showTooltip && (
                  <div className='absolute left-1/2 top-6 z-50 w-64 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg'>
                    IBC transfers post the destination address publicly on the source chain. Use this randomized deposit address to preserve privacy when transferring funds into Penumbra.
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={handleToggle}
              className={`relative h-5 w-9 rounded-full transition-colors duration-200 ${
                ibcDeposit ? 'bg-green-500' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
                  ibcDeposit ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        )}

        <div className='w-full'>
          <div className='mb-1 text-xs text-muted-foreground'>
            {ibcDeposit && isPenumbra ? 'ibc deposit address' : 'address'}
          </div>
          <div className={`flex items-center gap-2 rounded-lg border p-3 ${
            ibcDeposit && isPenumbra
              ? 'border-green-500/40 bg-green-500/5'
              : 'border-border/40 bg-muted/30'
          }`}>
            <code className={`flex-1 break-all text-xs ${
              ibcDeposit && isPenumbra ? 'text-green-400' : ''
            }`}>
              {isLoading ? 'generating...' : displayAddress || 'no wallet selected'}
            </code>
            {displayAddress && (
              <button
                onClick={copyAddress}
                className='shrink-0 text-muted-foreground transition-colors duration-75 hover:text-foreground'
              >
                {copied ? <CheckIcon className='h-4 w-4' /> : <CopyIcon className='h-4 w-4' />}
              </button>
            )}
          </div>
        </div>

        <p className='text-center text-xs text-muted-foreground'>
          {ibcDeposit && isPenumbra
            ? 'Use this address to receive IBC deposits privately. A new address is generated each time.'
            : `Only send ${activeNetwork?.toUpperCase() ?? ''} assets to this address.`
          }
        </p>

        {/* IBC Deposit / Shield section - Penumbra only */}
        {isPenumbra && (
          <IbcDepositSection
            selectedKeyInfo={selectedKeyInfo}
            keyRing={keyRing}
            penumbraWallet={penumbraWallet}
          />
        )}
      </div>
    </div>
  );
}

export default ReceivePage;
