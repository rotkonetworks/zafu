/**
 * One transparent chain's editable RPC endpoint pool, as a Row(value) that
 * opens a Sheet (the header says how many endpoints are in use and whether
 * they are the shipped defaults; the Sheet edits the list - nothing expands
 * in place).
 *
 * Deposit-address lookups rotate across the pool per address, so no single
 * provider can link all of a user's addresses. Defaults come from the chain
 * config (packages/wallet cosmos chains), which includes the endpoint Keplr's
 * chain registry lists for the chain.
 *
 * The Penumbra networks panel also passes whether the chain has a live IBC
 * channel to Penumbra, and the allow/block controls for its shipped hosts as
 * children, so each chain is one row instead of appearing in two lists.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { cn } from '@repo/ui/lib/utils';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { defaultRpcPool, useRpcPool } from '../../../hooks/transparent-rpc';
import { useHiddenChains } from '../../../hooks/cosmos-balance';

/** "channel open" / "no channel" tag; nothing while the channel list loads. */
export const ChannelTag = ({ open }: { open?: boolean }) =>
  open === undefined ? null : (
    <span
      className={cn(
        'flex items-center gap-1 text-label lowercase',
        open ? 'text-fg-muted' : 'text-fg-dim',
      )}
    >
      <span className={cn('h-1.5 w-1.5', open ? 'bg-green-400' : 'bg-fg-dim')} />
      {open ? 'channel open' : 'no channel'}
    </span>
  );

/** the chain's endpoint pool, edited in a Sheet; also opened from the penumbra home */
export const RpcPoolSheet = ({
  chainId,
  open,
  onOpenChange,
  children,
}: {
  chainId: CosmosChainId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** extra controls at the bottom of the sheet */
  children?: ReactNode;
}) => {
  const { pool, isCustom, save, reset } = useRpcPool(chainId);
  const [draft, setDraft] = useState<string[]>(pool);
  const [saved, setSaved] = useState(false);

  // sync the draft when the persisted pool loads/changes (but not mid-edit)
  useEffect(() => {
    setDraft(pool);
  }, [pool]);

  const setAt = (i: number, v: string) => setDraft(d => d.map((u, j) => (j === i ? v : u)));
  const removeAt = (i: number) => setDraft(d => d.filter((_, j) => j !== i));
  const add = () => setDraft(d => [...d, '']);

  const dirty = JSON.stringify(draft.map(s => s.trim()).filter(Boolean)) !== JSON.stringify(pool);

  const onSave = async () => {
    await save(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={COSMOS_CHAINS[chainId].name}>
      <div className='flex flex-col gap-3'>
        <div
          className='flex flex-col gap-1.5'
          title='deposit-address lookups rotate across these endpoints, so no single provider can link all of your addresses. add your own for more separation.'
        >
          {draft.map((url, i) => (
            <div key={i} className='flex items-center gap-1.5'>
              <input
                type='text'
                value={url}
                onChange={e => setAt(i, e.target.value)}
                placeholder='https://...'
                className='min-w-0 flex-1 border border-border-soft bg-input px-2.5 py-1.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
              />
              <button
                type='button'
                onClick={() => removeAt(i)}
                className='shrink-0 text-fg-muted transition-colors hover:text-hanko'
                title='remove endpoint'
              >
                <span className='i-ph-x h-3.5 w-3.5' />
              </button>
            </div>
          ))}
        </div>

        <div className='flex items-center gap-3'>
          <button
            type='button'
            onClick={add}
            className='flex items-center gap-1 text-label text-network-accent transition-colors hover:text-fg-high lowercase'
          >
            <span className='i-ph-plus h-3 w-3' /> add endpoint
          </button>
          {isCustom && (
            <button
              type='button'
              onClick={() => void reset()}
              className='text-label text-fg-muted transition-colors hover:text-fg-high lowercase'
              title='revert to the shipped defaults'
            >
              reset
            </button>
          )}
          <div className='flex-1' />
          <Button
            variant='primary'
            size='md'
            onClick={() => void onSave()}
            disabled={!dirty}
            className={cn('text-xs', saved && 'opacity-70')}
          >
            {saved ? 'saved' : 'save'}
          </Button>
        </div>

        {draft.filter(s => s.trim()).length === 0 && (
          <p className='text-label text-fg-dim lowercase'>
            empty - saving reverts to the {defaultRpcPool(chainId).length} shipped defaults.
          </p>
        )}

        {children && <div className='border-t border-border-soft pt-2'>{children}</div>}
      </div>
    </Sheet>
  );
};

export const TransparentChainEndpoints = ({
  chainId,
  channelOpen,
  children,
}: {
  chainId: CosmosChainId;
  /** live IBC channel to Penumbra; undefined while unknown */
  channelOpen?: boolean;
  /** extra controls at the bottom of the expanded row */
  children?: ReactNode;
}) => {
  const config = COSMOS_CHAINS[chainId];
  const { pool, isCustom } = useRpcPool(chainId);
  const { hidden, setHidden } = useHiddenChains();
  const isHidden = hidden.includes(chainId);
  const [open, setOpen] = useState(false);

  return (
    <RowGroup>
      <Row
        type='value'
        label={config.name}
        value={`${pool.length} ${pool.length === 1 ? 'endpoint' : 'endpoints'}${isCustom ? ' · custom' : ''}${isHidden ? ' · hidden' : ''}`}
        description={
          config.deprecation
            ? `${config.deprecation.reason} move funds out by ${config.deprecation.moveOutBy}.`
            : undefined
        }
        onPress={() => setOpen(true)}
      />
      <RpcPoolSheet chainId={chainId} open={open} onOpenChange={setOpen}>
        {channelOpen !== undefined && <ChannelTag open={channelOpen} />}
        <Row
          type='toggle'
          label='show on home'
          checked={!isHidden}
          onChange={show => void setHidden(chainId, !show)}
        />
        {children}
      </RpcPoolSheet>
    </RowGroup>
  );
};
