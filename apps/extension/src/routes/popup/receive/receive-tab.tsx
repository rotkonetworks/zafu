/**
 * Receive tab - QR + address, for Penumbra (ephemeral-only) and Zcash
 * (shielded default, transparent secondary via Segmented).
 *
 * Penumbra receive is ephemeral-ONLY: a fresh randomized single-use address
 * that rotates on every copy. The static index address is deliberately not
 * offered - ephemeral addresses never expire (the FVK detects funds sent to
 * any of them forever), so a static address buys nothing for receiving and
 * only invites reuse, which links payments off-chain.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../state';
import {
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  keyRingSelector,
} from '../../../state/keyring';
import { getActiveWalletJson } from '../../../state/wallets';
import {
  derivePenumbraEphemeralFromMnemonic,
  derivePenumbraEphemeralFromFvk,
} from '../../../hooks/use-address';
import { QrCode } from '../../../components/qr-code';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { useTransparentAddress } from './use-transparent-address';
import { PaymentRequestSheet } from './payment-request';

export function ReceiveTab({
  address,
  loading,
  stale,
  activeNetwork,
  retireShielded,
}: {
  address: string;
  loading: boolean;
  /** the zcash shielded address on screen is retired; its replacement is deriving */
  stale: boolean;
  activeNetwork: string;
  /** hand the zcash shielded address on screen out, and move to a fresh one */
  retireShielded: () => void;
}) {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const keyRing = useStore(keyRingSelector);
  const penumbraWallet = useStore(getActiveWalletJson);

  const isPenumbra = activeNetwork === 'penumbra';
  const isZcash = activeNetwork === 'zcash';

  const [addrType, setAddrType] = useState<'shielded' | 'transparent'>('shielded');
  const transparent = addrType === 'transparent';
  const t = useTransparentAddress(isZcash && transparent);

  // Penumbra ephemeral address - bumped on each copy to rotate to a fresh one
  // for the next share. Derivation touches the keyring/wasm, so it stays an
  // effect (external system); the nonce is the trigger, not a mirror of state.
  const [ephemeralAddress, setEphemeralAddress] = useState('');
  const [ephemeralLoading, setEphemeralLoading] = useState(false);
  const [ephemeralNonce, setEphemeralNonce] = useState(0);
  useEffect(() => {
    if (!isPenumbra) {
      return;
    }
    let cancelled = false;
    setEphemeralLoading(true);
    void (async () => {
      try {
        let addr: string;
        if (selectedKeyInfo?.type === 'mnemonic') {
          const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
          addr = await derivePenumbraEphemeralFromMnemonic(mnemonic, penumbraAccount);
        } else if (penumbraWallet?.fullViewingKey) {
          addr = await derivePenumbraEphemeralFromFvk(
            penumbraWallet.fullViewingKey,
            penumbraAccount,
          );
        } else {
          // No key material to derive from yet - clear loading, show the
          // empty state, never fall back to the static address.
          if (!cancelled) {
            setEphemeralLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setEphemeralAddress(addr);
          setEphemeralLoading(false);
        }
      } catch (err) {
        console.error('failed to generate ephemeral address:', err);
        if (!cancelled) {
          setEphemeralLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isPenumbra,
    penumbraAccount,
    ephemeralNonce,
    selectedKeyInfo?.id,
    selectedKeyInfo?.type,
    penumbraWallet?.fullViewingKey,
  ]);

  const displayAddress =
    transparent && isZcash && t.address ? t.address : isPenumbra ? ephemeralAddress : address;
  const isLoading = transparent && isZcash ? t.loading : isPenumbra ? ephemeralLoading : loading;
  const showingEphemeral = isPenumbra && !!ephemeralAddress;
  const isShielded = (isZcash && !transparent && displayAddress?.startsWith('u')) || isPenumbra;
  // a retired shielded address stays on screen until its replacement lands,
  // so only the address and QR change, but it can't be handed out again
  const retired = stale && isZcash && !transparent;

  const { copied, copy } = useCopy();
  const copyAddress = useCallback(() => {
    if (!displayAddress || retired) {
      return;
    }
    copy(displayAddress);
    // Rotate: after copying an ephemeral penumbra address, advance to a fresh
    // one so the next share is unlinkable. The just-copied one stays valid
    // forever - the wallet's FVK detects every ephemeral.
    if (showingEphemeral) {
      setEphemeralNonce(n => n + 1);
    }
    // same for zcash shielded: the copied address goes to one sender only
    if (isZcash && !transparent) {
      retireShielded();
    }
  }, [displayAddress, retired, showingEphemeral, isZcash, transparent, retireShielded, copy]);

  const [requestOpen, setRequestOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className='flex flex-col items-center gap-4'>
      <div
        className={`border border-surface-border-soft transition-opacity duration-150 ${retired ? 'opacity-30' : ''}`}
      >
        {isLoading ? (
          <div className='h-48 w-48 animate-pulse bg-surface-elev-2/40' />
        ) : displayAddress ? (
          <QrCode value={displayAddress} size={192} label='address QR' />
        ) : (
          <div className='flex h-48 w-48 items-center justify-center'>
            <span className='text-label text-fg-dim lowercase'>no wallet</span>
          </div>
        )}
      </div>

      <div className='flex items-center gap-1.5'>
        <span className='border border-network-accent/30 bg-network-accent/10 px-2.5 py-0.5 text-label text-network-accent lowercase tracking-[0.08em]'>
          {activeNetwork}
        </span>
        {isShielded && (
          <span
            className='inline-flex items-center gap-1 border border-zigner-gold/30 bg-zigner-gold/10 px-2 py-0.5 text-label text-zigner-gold lowercase tracking-[0.05em]'
            title='shielded - senders cannot see your other transactions'
          >
            <span className='i-ph-shield-check h-2.5 w-2.5' />
            shielded
          </span>
        )}
        {isZcash && transparent && (
          <span
            className='inline-flex items-center gap-1 border border-hanko/30 bg-hanko/10 px-2 py-0.5 text-label text-hanko-light lowercase tracking-[0.05em]'
            title='transparent - balance and history publicly visible'
          >
            <span className='i-ph-eye h-2.5 w-2.5' />
            public
          </span>
        )}
      </div>

      {isZcash && (
        <Segmented
          label='address type'
          value={addrType}
          onChange={setAddrType}
          options={[
            { value: 'shielded', label: 'shielded' },
            { value: 'transparent', label: 'transparent' },
          ]}
          className='w-full'
        />
      )}

      {isZcash && transparent && t.error && (
        <p className='w-full text-label text-hanko-light lowercase'>{t.error}</p>
      )}

      {isZcash && transparent && t.canDerive && !t.error && (
        <button
          type='button'
          onClick={() => setAdvancedOpen(true)}
          className='flex w-full items-center justify-between px-1 py-1 text-label text-fg-muted lowercase hover:text-fg-high'
        >
          <span>advanced - address #{t.index}</span>
          <span className='i-ph-caret-right size-3.5' />
        </button>
      )}

      <div className='w-full'>
        <div className='mb-1 text-label text-fg-muted lowercase'>
          {showingEphemeral
            ? 'ephemeral address'
            : transparent && isZcash
              ? `transparent address #${t.index} - public`
              : isZcash
                ? 'shielded address'
                : 'address'}
        </div>
        {isZcash && transparent && t.used && (
          <p className='mb-1 flex items-start gap-1.5 text-label text-hanko-light lowercase'>
            <span className='i-ph-warning mt-0.5 size-3 shrink-0' />
            this address was used before - reusing it publicly links your payments. rotate to a
            fresh one.
          </p>
        )}
        <div
          className={`flex items-center gap-2 border p-3 ${
            showingEphemeral
              ? 'border-zigner-gold/40 bg-zigner-gold/5'
              : transparent && isZcash
                ? 'border-hanko/35 bg-hanko/8'
                : 'border-surface-border-soft bg-surface-elev-2'
          }`}
        >
          <code
            className={`flex-1 break-all text-label transition-opacity duration-150 ${
              showingEphemeral
                ? 'text-zigner-gold'
                : transparent && isZcash
                  ? 'text-hanko-light'
                  : ''
            } ${retired ? 'opacity-30' : ''}`}
          >
            {isLoading ? 'generating...' : displayAddress || 'no wallet selected'}
          </code>
          {showingEphemeral && (
            <button
              onClick={() => setEphemeralNonce(n => n + 1)}
              className='flex shrink-0 items-center text-fg-muted transition-colors hover:text-fg-high'
              title='rotate to a fresh address'
              aria-label='rotate to a fresh ephemeral address'
            >
              <span className='i-ph-arrows-clockwise size-4' />
            </button>
          )}
          {isZcash && transparent && (
            <button
              onClick={t.advance}
              className='flex shrink-0 items-center text-fg-muted transition-colors hover:text-fg-high'
              title='new address'
              aria-label='new transparent address'
            >
              <span className='i-ph-arrows-clockwise size-4' />
            </button>
          )}
        </div>
      </div>

      {!showingEphemeral && transparent && (
        <p className='text-center text-label text-fg-muted leading-snug lowercase'>
          public on-chain - one index per sender, then shield into your private pool.
        </p>
      )}

      <div className='flex w-full gap-2'>
        {isZcash && displayAddress && (
          <Button variant='secondary' onClick={() => setRequestOpen(true)} className='flex-1'>
            request amount
          </Button>
        )}
        <Button onClick={copyAddress} disabled={!displayAddress || retired} className='flex-1'>
          {copied ? 'copied' : 'copy address'}
        </Button>
      </div>

      {isZcash && displayAddress && (
        <PaymentRequestSheet
          open={requestOpen}
          onOpenChange={setRequestOpen}
          address={displayAddress}
          isShielded={isShielded}
          onCopied={() => {
            setRequestOpen(false);
            if (!transparent) {
              retireShielded();
            }
          }}
        />
      )}

      {isZcash && transparent && (
        <Sheet open={advancedOpen} onOpenChange={setAdvancedOpen} title='address index'>
          <div className='flex w-full items-center justify-center gap-3 py-2'>
            <button
              disabled={t.index <= 0}
              onClick={() => t.setIndex(i => i - 1)}
              className='p-1 text-fg-muted transition-colors hover:text-fg-high disabled:opacity-50'
            >
              <span className='i-ph-caret-left size-4' />
            </button>
            <span className='min-w-[110px] text-center text-label text-fg-muted'>
              address #{t.index}
            </span>
            <button
              onClick={t.advance}
              className='p-1 text-fg-muted transition-colors hover:text-fg-high'
            >
              <span className='i-ph-caret-right size-4' />
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
