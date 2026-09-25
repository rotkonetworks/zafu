/**
 * Receive on a transparent chain (Injective, ...): a fresh HD address every
 * time, never one shown before. Earlier addresses stay listed (and scanned),
 * since an exchange often keeps paying a whitelisted address.
 */

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { conduitFor } from '@repo/wallet/networks/transparent/conduit';
import { QrCode } from '../../../components/qr-code';
import { useStore } from '../../../state';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
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
  const queryClient = useQueryClient();
  const keyId = selectedKeyInfo?.type === 'mnemonic' ? selectedKeyInfo.id : undefined;

  const [nonce, setNonce] = useState(0);
  const [current, setCurrent] = useState<{ index: number; address: string }>();
  const [copied, setCopied] = useState(false);
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
        // the deposit scan picks the new index up
        void queryClient.invalidateQueries({ queryKey: ['cosmosDepositWallets', chainId] });
      }
    })().catch(err => console.error(`[receive] ${chainId} address failed:`, err));
    return () => {
      cancelled = true;
    };
  }, [chainId, keyId, getMnemonic, nonce, queryClient]);

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

  const copy = useCallback((address: string) => {
    void navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  if (!keyId) {
    return (
      <div className='border border-border-soft bg-elev-1 p-4 text-sm text-fg-muted lowercase'>
        cold wallets can't derive a {cfg.name} address in-app yet.
      </div>
    );
  }

  return (
    <div className='flex flex-col items-center gap-3'>
      {current ? (
        <QrCode value={current.address} size={176} label={`${cfg.name} address QR`} />
      ) : (
        <div className='h-[176px] w-[176px] animate-pulse bg-elev-2' />
      )}
      <div className='flex w-full items-center gap-2 border border-border-soft px-3 py-2'>
        <span className='truncate font-mono text-xs' title={current?.address}>
          {current?.address ?? 'deriving...'}
        </span>
        <button
          type='button'
          onClick={() => setNonce(n => n + 1)}
          className='flex shrink-0 items-center text-fg-muted hover:text-fg-high'
          title='new address'
          aria-label='new address'
        >
          <span className='i-ph-arrows-clockwise h-4 w-4' />
        </button>
        <button
          type='button'
          onClick={() => current && copy(current.address)}
          disabled={!current}
          className='shrink-0 text-label text-fg-muted hover:text-fg-high disabled:opacity-40'
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>

      <div className='w-full'>
        <button
          type='button'
          onClick={() => setShowEarlier(v => !v)}
          className='flex items-center gap-1 text-label text-fg-muted lowercase hover:text-fg-high'
        >
          <span className={`h-3 w-3 ${showEarlier ? 'i-ph-caret-down' : 'i-ph-caret-right'}`} />
          earlier addresses
        </button>
        {showEarlier && (
          <div className='mt-1 flex flex-col'>
            {earlier === undefined ? (
              <span className='px-1.5 py-1 text-label text-fg-dim'>deriving...</span>
            ) : earlier.length === 0 ? (
              <span className='px-1.5 py-1 text-label text-fg-dim'>none yet</span>
            ) : (
              earlier.map(r => (
                <button
                  key={r.index}
                  type='button'
                  onClick={() => copy(r.address)}
                  title={r.address}
                  className='flex items-center gap-2 px-1.5 py-1 text-left font-mono text-label text-fg-muted hover:bg-elev-2'
                >
                  <span className='w-8 shrink-0'>#{r.index}</span>
                  <span className='truncate'>{shortAddress(r.address)}</span>
                  <span className='i-ph-copy ml-auto h-3 w-3 shrink-0' />
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
