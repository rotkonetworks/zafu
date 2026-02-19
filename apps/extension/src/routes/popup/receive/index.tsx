/**
 * receive screen - show QR code for current address
 *
 * for penumbra: supports IBC deposit addresses (ephemeral) to preserve privacy
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, CopyIcon, CheckIcon, InfoCircledIcon } from '@radix-ui/react-icons';
import { PopupPath } from '../paths';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectEffectiveKeyInfo, keyRingSelector } from '../../../state/keyring';
import { getActiveWalletJson } from '../../../state/wallets';
import { useActiveAddress } from '../../../hooks/use-address';
import {
  derivePenumbraEphemeralFromMnemonic,
  derivePenumbraEphemeralFromFvk,
} from '../../../hooks/use-address';
import QRCode from 'qrcode';

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
    // intentionally re-run when ibcDeposit toggles ON to generate a new address each time
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
    <div className='flex flex-col'>
      <div className='flex items-center gap-3 border-b border-border/40 px-4 py-3'>
        <button
          onClick={() => navigate(PopupPath.INDEX)}
          className='text-muted-foreground transition-colors duration-75 hover:text-foreground'
        >
          <ArrowLeftIcon className='h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium text-foreground'>receive</h1>
      </div>

      <div className='flex flex-col items-center gap-4 p-6'>
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
      </div>
    </div>
  );
}

export default ReceivePage;
