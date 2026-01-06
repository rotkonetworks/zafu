/**
 * receive screen - show QR code for current address
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, CopyIcon, CheckIcon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { activeNetworkSelector } from '../../../state/active-network';
import QRCode from 'qrcode';

export function ReceivePage() {
  const navigate = useNavigate();
  const { activeNetwork } = useStore(activeNetworkSelector);
  const [copied, setCopied] = useState(false);
  const [address, setAddress] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // TODO: fetch address from view service / wallet based on network
  useEffect(() => {
    // placeholder - will be wired to actual address derivation
    const placeholder = activeNetwork === 'penumbra'
      ? 'penumbra1...'
      : activeNetwork === 'zcash'
        ? 'u1...'
        : activeNetwork === 'polkadot'
          ? '1...'
          : '';
    setAddress(placeholder);
  }, [activeNetwork]);

  // generate QR code
  useEffect(() => {
    if (canvasRef.current && address) {
      QRCode.toCanvas(canvasRef.current, address, {
        width: 192,
        margin: 2,
        color: { dark: '#000', light: '#fff' },
      });
    }
  }, [address]);

  const copyAddress = useCallback(async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  return (
    <div className='flex flex-col'>
      <div className='flex items-center gap-3 border-b border-border/40 px-4 py-3'>
        <button
          onClick={() => navigate(-1)}
          className='text-muted-foreground transition-colors duration-75 hover:text-foreground'
        >
          <ArrowLeftIcon className='h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium text-foreground'>receive</h1>
      </div>

      <div className='flex flex-col items-center gap-4 p-6'>
        <div className='rounded-xl border border-border bg-white p-2'>
          {address ? (
            <canvas ref={canvasRef} className='h-48 w-48' />
          ) : (
            <div className='flex h-48 w-48 items-center justify-center'>
              <span className='text-xs text-muted-foreground'>No address</span>
            </div>
          )}
        </div>

        <span className='rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize'>
          {activeNetwork}
        </span>

        <div className='w-full'>
          <div className='mb-1 text-xs text-muted-foreground'>Address</div>
          <div className='flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 p-3'>
            <code className='flex-1 break-all text-xs'>
              {address || 'No wallet selected'}
            </code>
            {address && (
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
          Only send {activeNetwork?.toUpperCase() ?? ''} assets to this address.
        </p>
      </div>
    </div>
  );
}

export default ReceivePage;
