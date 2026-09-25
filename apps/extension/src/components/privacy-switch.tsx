/**
 * Shielded vs transparent, then - for transparent - which network. Privacy is
 * the first choice; the transparent chains (Injective, Noble, ...) are one
 * option with a network picker under it, not peers of shielded.
 */

import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { cn } from '@repo/ui/lib/utils';

export type Privacy = 'shielded' | 'transparent';

/** networks to offer, the ones being wound down last */
export const orderTransparentChains = (chains: readonly CosmosChainId[]): CosmosChainId[] =>
  [...chains].sort(
    (a, b) => Number(!!COSMOS_CHAINS[a].deprecation) - Number(!!COSMOS_CHAINS[b].deprecation),
  );

export const PrivacySwitch = ({
  privacy,
  onPrivacy,
  chains,
  chain,
  onChain,
}: {
  privacy: Privacy;
  onPrivacy: (p: Privacy) => void;
  /** transparent networks, in display order */
  chains: readonly CosmosChainId[];
  chain: CosmosChainId | undefined;
  onChain: (c: CosmosChainId) => void;
}) => (
  <div className='mb-4 flex flex-col gap-2'>
    <div className='flex gap-1 border border-border-soft p-1' role='tablist'>
      {(['shielded', 'transparent'] as const).map(p => (
        <button
          key={p}
          type='button'
          role='tab'
          aria-selected={privacy === p}
          onClick={() => onPrivacy(p)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-1.5 text-xs lowercase transition-colors',
            privacy === p ? 'bg-elev-2 text-fg-high' : 'text-fg-muted hover:text-fg-high',
          )}
        >
          <span
            className={cn(
              'h-3.5 w-3.5',
              p === 'shielded' ? 'i-ph-shield-check' : 'i-ph-eye',
              privacy === p && p === 'shielded' && 'text-zigner-gold',
            )}
          />
          {p}
        </button>
      ))}
    </div>
    {privacy === 'transparent' &&
      (chains.length > 1 ? (
        <div className='flex flex-wrap gap-1' role='radiogroup' aria-label='network'>
          {chains.map(c => (
            <button
              key={c}
              type='button'
              role='radio'
              aria-checked={chain === c}
              onClick={() => onChain(c)}
              className={cn(
                'border px-2.5 py-1 text-xs lowercase transition-colors',
                chain === c
                  ? 'border-zigner-gold text-fg-high'
                  : 'border-border-soft text-fg-muted hover:text-fg-high',
              )}
            >
              {COSMOS_CHAINS[c].name}
            </button>
          ))}
        </div>
      ) : chains[0] ? (
        <span className='text-xs text-fg-muted lowercase'>on {COSMOS_CHAINS[chains[0]].name}</span>
      ) : null)}
  </div>
);
