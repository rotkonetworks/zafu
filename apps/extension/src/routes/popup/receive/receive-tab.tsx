/**
 * Receive tab - QR + address, for Penumbra (ephemeral-only) and Zcash
 * (shielded default, transparent secondary - the header picks addrType).
 * A zcash pocket rotates its shielded address but has exactly one
 * transparent address, index 0 of its own t-branch.
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
import { getActiveWalletJson, selectActiveZcashWallet } from '../../../state/wallets';
import {
  derivePenumbraEphemeralFromMnemonic,
  derivePenumbraEphemeralFromFvk,
} from '../../../hooks/use-address';
import { QrCode } from '../../../components/qr-code';
import { Button } from '@repo/ui/components/ui/button';
import { useCopy } from '@repo/ui/hooks/use-copy';
import {
  useTransparentAddresses,
  type NoTransparent,
} from '../../../hooks/use-transparent-addresses';
import { PaymentRequestSheet } from './payment-request';

const noTransparentCopy: Record<NoTransparent, string> = {
  undecryptable: 'this wallet cannot be opened here · re-importing it will help',
  'no-transparent-key':
    'this key has no transparent part · importing from an updated zigner will add one',
};

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
  const isMainnet = useStore(s => selectActiveZcashWallet(s)?.mainnet ?? true);
  const t = useTransparentAddresses(isMainnet);
  const zcashTransparent = isZcash && transparent;

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

  const displayAddress = zcashTransparent
    ? (t.tAddresses[0] ?? '')
    : isPenumbra
      ? ephemeralAddress
      : address;
  const isLoading = zcashTransparent ? t.isLoading : isPenumbra ? ephemeralLoading : loading;
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

  // one row of copy/colour/rotate per address kind, instead of a ternary per
  // concern - label, hint, colours and the rotate action all vary on the
  // same discriminator.
  const plain = 'border-surface-border-soft bg-surface-elev-2';
  const kinds = {
    ephemeral: {
      label: 'ephemeral address',
      hint: '',
      labelColor: 'text-fg-muted',
      addrColor: 'text-zigner-gold',
      box: 'border-zigner-gold/40 bg-zigner-gold/5',
      rotate: () => setEphemeralNonce(n => n + 1),
    },
    transparent: {
      label: 'transparent address · public',
      hint: 'shield after receiving',
      labelColor: 'text-hanko-light',
      addrColor: 'text-hanko-light',
      box: 'border-hanko/35 bg-hanko/8',
      rotate: undefined,
    },
    shielded: {
      label: 'shielded address',
      hint: 'one address per sender',
      labelColor: 'text-fg-muted',
      addrColor: 'text-fg-high',
      box: plain,
      rotate: retireShielded,
    },
    none: {
      label: 'address',
      hint: '',
      labelColor: 'text-fg-muted',
      addrColor: 'text-fg-high',
      box: plain,
      rotate: undefined as (() => void) | undefined,
    },
  } as const;
  const kind: keyof typeof kinds = showingEphemeral
    ? 'ephemeral'
    : isZcash && transparent
      ? 'transparent'
      : isZcash
        ? 'shielded'
        : 'none';
  const m = kinds[kind];

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

      {zcashTransparent && t.missing && (
        <p className='w-full text-label text-hanko-light lowercase'>
          {noTransparentCopy[t.missing]}
        </p>
      )}

      <div className='w-full'>
        <div className='mb-1.5 flex items-center justify-between text-label lowercase'>
          <span className={m.labelColor}>{m.label}</span>
          {m.hint && <span className='text-fg-muted'>{m.hint}</span>}
        </div>
        <div className='flex gap-1.5'>
          <div className={`flex h-14 min-w-0 flex-1 items-center border p-3 ${m.box}`}>
            <code
              title={displayAddress || undefined}
              className={`w-full truncate text-label transition-opacity duration-150 ${m.addrColor} ${retired ? 'opacity-30' : ''}`}
            >
              {isLoading ? 'generating...' : displayAddress || 'no wallet selected'}
            </code>
          </div>
          {m.rotate && (
            <button
              onClick={m.rotate}
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
    </div>
  );
}
