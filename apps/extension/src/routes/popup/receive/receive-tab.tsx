/**
 * Shielded receive, one component per network on the shared AddressView.
 *
 * Zcash: a shielded address per sender (retired on copy and on leaving), or
 * the pocket's one transparent address - the header picks which.
 *
 * Penumbra is ephemeral-only: a fresh randomized address that rotates on
 * every copy. The static index address is deliberately not offered -
 * ephemeral addresses never expire (the FVK detects funds sent to any of
 * them forever), so a static address buys nothing and only invites reuse,
 * which links payments off-chain.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../state';
import {
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  keyRingSelector,
} from '../../../state/keyring';
import { getActiveWalletJson, selectZcashIsMainnet } from '../../../state/wallets';
import {
  derivePenumbraEphemeralFromMnemonic,
  derivePenumbraEphemeralFromFvk,
} from '../../../hooks/use-address';
import { Button } from '@repo/ui/components/ui/button';
import { useCopy } from '@repo/ui/hooks/use-copy';
import {
  useTransparentAddresses,
  type NoTransparent,
} from '../../../hooks/use-transparent-addresses';
import { PaymentRequestSheet } from './payment-request';
import { AddressView } from './address-view';

const noTransparentCopy: Record<NoTransparent, string> = {
  undecryptable: 'this wallet cannot be opened here · re-importing it will help',
  'no-transparent-key':
    'this key has no transparent part · importing from an updated zigner will add one',
};

export type AddrType = 'shielded' | 'transparent';

export function ZcashReceive({
  address,
  loading,
  stale,
  retireShielded,
  addrType,
}: {
  address: string;
  loading: boolean;
  /** the shielded address on screen is retired; its replacement is deriving */
  stale: boolean;
  /** hand the shielded address on screen out, and move to a fresh one */
  retireShielded: () => void;
  addrType: AddrType;
}) {
  const transparent = addrType === 'transparent';
  const isMainnet = useStore(selectZcashIsMainnet);
  const t = useTransparentAddresses(isMainnet);
  const shown = transparent ? (t.tAddresses[0] ?? '') : address;
  // a retired shielded address stays on screen until its replacement lands,
  // but it can't be handed out again
  const pending = stale && !transparent;
  const { copied, copy } = useCopy();
  const [requestOpen, setRequestOpen] = useState(false);
  // a copied payment request stays on screen as it was copied, so its code is
  // that same request (address, amount, memo) while the next address derives
  const [request, setRequest] = useState<{ uri: string; of: AddrType }>();
  const held = request?.of === addrType ? request.uri : undefined;
  const copyAddress = () => {
    if (held) {
      copy(held);
      return;
    }
    if (!shown || pending) {
      return;
    }
    copy(shown);
    // the copied address goes to one sender only
    if (!transparent) {
      retireShielded();
    }
  };

  return (
    <>
      <AddressView
        address={held ?? shown}
        loading={transparent ? t.isLoading : loading}
        retired={!held && pending}
        label={
          held
            ? 'payment request'
            : transparent
              ? 'transparent address · public'
              : 'shielded address'
        }
        hint={transparent ? 'shield after receiving' : 'one address per sender'}
        tone={transparent ? 'public' : 'plain'}
        onRotate={held ? () => setRequest(undefined) : transparent ? undefined : retireShielded}
        notice={transparent && t.missing && noTransparentCopy[t.missing]}
      >
        {shown && (
          <Button
            variant='secondary'
            onClick={() => setRequestOpen(true)}
            disabled={pending}
            className='w-[150px] shrink-0'
          >
            request amount
          </Button>
        )}
        <Button onClick={copyAddress} disabled={!held && (!shown || pending)} className='flex-1'>
          {copied ? 'copied' : held ? 'copy payment link' : 'copy address'}
        </Button>
      </AddressView>
      {shown && (
        <PaymentRequestSheet
          open={requestOpen}
          onOpenChange={setRequestOpen}
          address={shown}
          isShielded={!transparent && shown.startsWith('u')}
          onCopied={uri => {
            setRequestOpen(false);
            setRequest({ uri, of: addrType });
            // its address went out with the link: the next sender gets a fresh one
            if (!transparent) {
              retireShielded();
            }
          }}
        />
      )}
    </>
  );
}

export function PenumbraReceive() {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const keyRing = useStore(keyRingSelector);
  const penumbraWallet = useStore(getActiveWalletJson);

  // derivation touches the keyring/wasm, so it stays an effect; the nonce is
  // the rotate trigger, not a mirror of state
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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
          // nothing to derive from yet: never fall back to the static address
          if (!cancelled) {
            setLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setAddress(addr);
          setLoading(false);
        }
      } catch (err) {
        console.error('failed to generate ephemeral address:', err);
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    penumbraAccount,
    nonce,
    selectedKeyInfo?.id,
    selectedKeyInfo?.type,
    penumbraWallet?.fullViewingKey,
  ]);

  const { copied, copy } = useCopy();
  const rotate = useCallback(() => setNonce(n => n + 1), []);

  return (
    <AddressView
      address={address}
      loading={loading}
      label='shielded address'
      hint='one address per sender'
      onRotate={rotate}
    >
      <Button
        onClick={() => {
          copy(address);
          // the copied one stays valid forever; the next share is unlinkable
          rotate();
        }}
        disabled={!address}
        className='flex-1'
      >
        {copied ? 'copied' : 'copy address'}
      </Button>
    </AddressView>
  );
}

/** any other network: the one address it has */
export function PlainReceive({ address, loading }: { address: string; loading: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <AddressView address={address} loading={loading} label='address'>
      <Button onClick={() => copy(address)} disabled={!address} className='flex-1'>
        {copied ? 'copied' : 'copy address'}
      </Button>
    </AddressView>
  );
}
