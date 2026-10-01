/**
 * Receive tab - QR + address, for Penumbra (ephemeral-only) and Zcash
 * (shielded default, transparent secondary - the header picks addrType).
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
import { Button } from '@repo/ui/components/ui/button';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { useTransparentAddress } from './use-transparent-address';
import { PaymentRequestSheet } from './payment-request';
import { Sheet } from '@repo/ui/components/ui/sheet';

export type AddrType = 'shielded' | 'transparent';

export function ReceiveTab({
  address,
  loading,
  stale,
  activeNetwork,
  retireShielded,
  addrType,
}: {
  address: string;
  loading: boolean;
  /** the zcash shielded address on screen is retired; its replacement is deriving */
  stale: boolean;
  activeNetwork: string;
  /** hand the zcash shielded address on screen out, and move to a fresh one */
  retireShielded: () => void;
  /** zcash only - chosen in the header, not here */
  addrType: AddrType;
}) {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const keyRing = useStore(keyRingSelector);
  const penumbraWallet = useStore(getActiveWalletJson);

  const isPenumbra = activeNetwork === 'penumbra';
  const isZcash = activeNetwork === 'zcash';

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

  // right-of-label hint, matching the board's shielded/transparent copy
  const hint = showingEphemeral
    ? ''
    : transparent && isZcash
      ? 'shield after receiving'
      : isZcash
        ? 'one address per sender'
        : '';
  const label = showingEphemeral
    ? 'ephemeral address'
    : transparent && isZcash
      ? 'transparent address · public'
      : isZcash
        ? 'shielded address'
        : 'address';
  const addrColor = showingEphemeral
    ? 'text-zigner-gold'
    : transparent && isZcash
      ? 'text-hanko-light'
      : 'text-fg-high';
  // one rotate button for every mode: a fresh ephemeral, the next transparent
  // index, or a fresh shielded diversifier.
  const rotate = showingEphemeral
    ? () => setEphemeralNonce(n => n + 1)
    : isZcash && transparent
      ? t.advance
      : isZcash
        ? retireShielded
        : undefined;

  return (
    <div className='flex flex-1 flex-col items-center gap-4'>
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

      {isZcash && transparent && t.error && (
        <p className='w-full text-label text-hanko-light lowercase'>{t.error}</p>
      )}

      <div className='w-full'>
        <div className='mb-1.5 flex items-center justify-between text-label lowercase'>
          <span className={transparent && isZcash ? 'text-hanko-light' : 'text-fg-muted'}>
            {label}
          </span>
          {hint && <span className='text-fg-muted'>{hint}</span>}
        </div>
        {isZcash && transparent && t.used && (
          <p className='mb-1 flex items-start gap-1.5 text-label text-hanko-light lowercase'>
            <span className='i-ph-warning mt-0.5 size-3 shrink-0' />
            this address was used before - reusing it publicly links your payments. rotate to a
            fresh one.
          </p>
        )}
        <div className='flex gap-1.5'>
          <div
            className={`flex h-14 min-w-0 flex-1 items-center border p-3 ${
              showingEphemeral
                ? 'border-zigner-gold/40 bg-zigner-gold/5'
                : transparent && isZcash
                  ? 'border-hanko/35 bg-hanko/8'
                  : 'border-surface-border-soft bg-surface-elev-2'
            }`}
          >
            <code
              title={displayAddress || undefined}
              className={`w-full truncate text-label transition-opacity duration-150 ${addrColor} ${retired ? 'opacity-30' : ''}`}
            >
              {isLoading ? 'generating...' : displayAddress || 'no wallet selected'}
            </code>
          </div>
          {rotate && (
            <button
              onClick={rotate}
              disabled={retired}
              className='grid size-14 shrink-0 place-items-center border border-surface-border-soft bg-surface-elev-1 text-fg-muted transition-colors hover:text-fg-high disabled:cursor-not-allowed disabled:opacity-50'
              title='new address'
              aria-label='new address'
            >
              <span className='i-ph-arrows-clockwise size-4.5' />
            </button>
          )}
        </div>
      </div>

      {isZcash && transparent && t.canDerive && !t.error && (
        <button
          type='button'
          onClick={() => setAdvancedOpen(true)}
          className='flex w-full items-center justify-between px-1 py-1 text-label text-fg-muted lowercase hover:text-fg-high'
        >
          <span>earlier addresses</span>
          <span className='i-ph-caret-right size-3.5' />
        </button>
      )}

      <div className='-mx-4 mt-auto flex gap-2 border-t border-surface-border-soft px-4 pt-4'>
        {isZcash && displayAddress && (
          <Button
            variant='secondary'
            onClick={() => setRequestOpen(true)}
            className='w-[150px] shrink-0'
          >
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
