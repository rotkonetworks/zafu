/**
 * Receive on a transparent chain (Injective, ...): a fresh HD address every
 * time, never one shown before. Earlier addresses stay listed (and scanned),
 * since an exchange often keeps paying a whitelisted address.
 */

import { useEffect, useState } from 'react';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { conduitFor } from '@repo/wallet/networks/transparent/conduit';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { useStore } from '../../../state';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
import { AddressView } from './address-view';
import { useChainInUse } from '../../../hooks/enable-network';
import {
  allocateTransparentAddress,
  readShownIndices,
  shortAddress,
} from '../../../transparent/hd';

/** how many earlier addresses the list derives at once */
const EARLIER_SHOWN = 10;

export const TransparentReceive = ({ chainId }: { chainId: CosmosChainId }) => {
  const cfg = COSMOS_CHAINS[chainId];
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  const keyId = selectedKeyInfo?.type === 'mnemonic' ? selectedKeyInfo.id : undefined;
  // funds sent here show on the penumbra home, on the way in
  useChainInUse(keyId ? chainId : undefined);

  const [nonce, setNonce] = useState(0);
  const [current, setCurrent] = useState<{ index: number; address: string }>();
  const [showEarlier, setShowEarlier] = useState(false);
  const [earlier, setEarlier] = useState<{ index: number; address: string }[]>();

  useEffect(() => {
    let cancelled = false;
    setCurrent(undefined);
    if (!keyId) {
      return;
    }
    void (async () => {
      // key first: allocating while locked would burn an index nobody sees
      const mnemonic = await getMnemonic(keyId);
      if (!mnemonic || cancelled) {
        return;
      }
      const next = await allocateTransparentAddress(chainId, keyId, mnemonic);
      if (!cancelled) {
        setCurrent(next);
        setEarlier(undefined);
      }
    })().catch(err => console.error(`[receive] ${chainId} address failed:`, err));
    return () => {
      cancelled = true;
    };
  }, [chainId, keyId, getMnemonic, nonce]);

  // earlier addresses, derived only when the list is opened
  useEffect(() => {
    let cancelled = false;
    if (!showEarlier || !keyId || earlier) {
      return;
    }
    void (async () => {
      const shown = (await readShownIndices(chainId, keyId))
        .filter(i => i !== current?.index)
        .slice(-EARLIER_SHOWN)
        .reverse();
      const mnemonic = await getMnemonic(keyId);
      const conduit = conduitFor(chainId);
      const rows: { index: number; address: string }[] = [];
      for (const index of shown) {
        if (cancelled) {
          return;
        }
        rows.push({ index, address: await conduit.deriveAddress(mnemonic, index) });
      }
      if (!cancelled) {
        setEarlier(rows);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showEarlier, keyId, chainId, current?.index, earlier, getMnemonic]);

  const { copied, copy } = useCopy();

  if (!keyId) {
    return (
      <StatusSlot icon='i-ph-info'>
        cold wallets can&apos;t derive a {cfg.name.toLowerCase()} address here yet
      </StatusSlot>
    );
  }

  return (
    <>
      <AddressView
        address={current?.address ?? ''}
        loading={!current}
        label={`${cfg.name.toLowerCase()} address · public`}
        hint='a new one each time'
        tone='public'
        onRotate={() => setNonce(n => n + 1)}
      >
        <Button
          variant='secondary'
          onClick={() => setShowEarlier(true)}
          className='w-[150px] shrink-0'
        >
          earlier
        </Button>
        <Button
          onClick={() => current && copy(current.address)}
          disabled={!current}
          className='flex-1'
        >
          {copied ? 'copied' : 'copy address'}
        </Button>
      </AddressView>
      <Sheet open={showEarlier} onOpenChange={setShowEarlier} title='earlier addresses'>
        <div className='min-h-0 overflow-y-auto'>
          {earlier === undefined || earlier.length === 0 ? (
            <p className='py-6 text-center text-xs text-fg-muted'>
              {earlier === undefined ? 'deriving' : 'none yet'}
            </p>
          ) : (
            <RowGroup>
              {earlier.map(r => (
                <Row
                  key={r.index}
                  type='value'
                  label={`#${r.index} ${shortAddress(r.address)}`}
                  value='copy'
                  onPress={() => copy(r.address)}
                />
              ))}
            </RowGroup>
          )}
        </div>
      </Sheet>
    </>
  );
};
