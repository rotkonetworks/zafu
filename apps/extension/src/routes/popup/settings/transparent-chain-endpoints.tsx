/**
 * One transparent chain's editable RPC node pool, in a Sheet. Opened from the
 * chain's row in settings > networks > penumbra > ibc chains (with the chain's
 * own toggles as children) and from the penumbra home's "another node".
 * Deposit-address lookups rotate across the pool per address, so no single
 * provider can link all of a user's addresses. An empty pool falls back to
 * the shipped defaults from the chain config.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { useRpcPool } from '../../../hooks/transparent-rpc';

const clean = (list: string[]) => list.map(s => s.trim()).filter(Boolean);

export const RpcPoolSheet = ({
  chainId,
  open,
  onOpenChange,
  children,
}: {
  chainId: CosmosChainId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the chain's own controls, above its nodes */
  children?: ReactNode;
}) => {
  const { pool, isCustom, save, reset } = useRpcPool(chainId);
  const [draft, setDraft] = useState<string[]>(pool);

  // the persisted pool loads from storage after mount, and changes on save or reset
  useEffect(() => {
    setDraft(pool);
  }, [pool]);

  const dirty = JSON.stringify(clean(draft)) !== JSON.stringify(pool);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={COSMOS_CHAINS[chainId].name.toLowerCase()}
    >
      {children}
      <div className='-mx-4 flex min-h-0 flex-col gap-1.5 overflow-y-auto px-4'>
        {draft.map((url, i) => (
          <div key={i} className='flex items-center gap-1.5'>
            <Input
              value={url}
              onChange={e => setDraft(d => d.map((u, j) => (j === i ? e.target.value : u)))}
              placeholder='https://...'
              className='font-mono text-xs'
            />
            <Button
              variant='quiet'
              className='w-12 shrink-0 px-0'
              aria-label='remove this node'
              onClick={() => setDraft(d => d.filter((_, j) => j !== i))}
            >
              <span className='i-lucide-x size-4' />
            </Button>
          </div>
        ))}
      </div>
      <div className='flex shrink-0 gap-2'>
        <Button variant='quiet' size='sm' onClick={() => setDraft(d => [...d, ''])}>
          add a node
        </Button>
        {isCustom && (
          <Button variant='quiet' size='sm' onClick={() => void reset()}>
            use the shipped nodes
          </Button>
        )}
      </div>
      <Button className='shrink-0' disabled={!dirty} onClick={() => void save(draft)}>
        save
      </Button>
    </Sheet>
  );
};
