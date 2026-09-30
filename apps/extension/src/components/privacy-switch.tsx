/**
 * Shielded vs transparent, then - for transparent - which network. Privacy is
 * the first choice; the transparent chains (Injective, Noble, ...) are one
 * option with a network picker under it, not peers of shielded.
 */

import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { Segmented } from '@repo/ui/components/ui/segmented';

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
    <Segmented
      label='privacy'
      value={privacy}
      onChange={onPrivacy}
      options={[
        { value: 'shielded', label: 'shielded', icon: 'i-ph-shield-check' },
        { value: 'transparent', label: 'transparent', icon: 'i-ph-eye' },
      ]}
    />
    {privacy === 'transparent' &&
      (chains.length > 1 && chains[0] ? (
        <Segmented
          label='network'
          value={chain ?? chains[0]}
          onChange={onChain}
          options={chains.map(c => ({ value: c, label: COSMOS_CHAINS[c].name }))}
        />
      ) : chains[0] ? (
        <span className='text-xs text-fg-muted lowercase'>on {COSMOS_CHAINS[chains[0]].name}</span>
      ) : null)}
  </div>
);
