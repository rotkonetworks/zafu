/**
 * Editable Noble RPC endpoint pool, shown as a subnetwork under Penumbra in
 * network settings. Deposit-address lookups rotate across this list per address
 * so no single provider can link them. Persisted via useNobleRpcPool.
 */

import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { useNobleRpcPool, defaultNobleRpcPool } from '../../../hooks/noble-rpc';

export const NobleEndpointsEditor = () => {
  const { pool, isCustom, save, reset } = useNobleRpcPool();
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
    <div className='flex flex-col gap-2'>
      <div className='flex items-center justify-between'>
        <span
          className='cursor-help text-label text-fg-muted lowercase'
          title='deposit-address lookups rotate across these endpoints, so no single provider can link all of your addresses. add your own for more separation.'
        >
          noble · rpc endpoints
        </span>
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
      </div>

      <div className='flex flex-col gap-1.5'>
        {draft.map((url, i) => (
          <div key={i} className='flex items-center gap-1.5'>
            <span className='w-4 shrink-0 text-center text-label text-fg-dim'>{i}</span>
            <input
              type='text'
              value={url}
              onChange={e => setAt(i, e.target.value)}
              placeholder='https://...'
              className='min-w-0 flex-1 rounded-md border border-border-soft bg-input px-2.5 py-1.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
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

      <div className='flex items-center gap-2'>
        <button
          type='button'
          onClick={add}
          className='flex items-center gap-1 text-label text-network-accent transition-colors hover:text-fg-high lowercase'
        >
          <span className='i-ph-plus h-3 w-3' /> add endpoint
        </button>
        <div className='flex-1' />
        <Button
          variant='gradient'
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
          empty - saving reverts to the {defaultNobleRpcPool().length} shipped defaults.
        </p>
      )}
    </div>
  );
};
