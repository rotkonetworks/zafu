/**
 * The networks directory - Penumbra's IBC side:
 *
 *  1. the ibc chains under penumbra - one row per chain with its rotating
 *     endpoint pool, whether a live channel to penumbra is open, and the
 *     egress decision on zafu's shipped rpc/rest, blockable/allowable inline;
 *  2. the user's own networks - a node they run or trust, added by hand, which
 *     then feeds the trusted egress inventory.
 *
 * Renders inside the Penumbra network panel (PenumbraIbcDirectory). The full
 * destination list ("everything zafu talks to", every known host with its
 * own allow/block control) is its own privacy screen now -
 * settings-connections.tsx - not folded away here.
 *
 * The egress decision lives in the ledger (`net/ledger.ts`), not here: this
 * screen is a view that re-reads after every mutation.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { ChannelTag, TransparentChainEndpoints } from './transparent-chain-endpoints';
import { useIbcChains } from '../../../hooks/ibc-chains';
import { hostOf, type DestinationState, type NetEgressState } from '../../../net/destination';
import { noteDestination, readNetEgress, setDestinationDecision } from '../../../net/ledger';
import {
  addCustomNetwork,
  readCustomNetworks,
  removeCustomNetwork,
  type CustomNetwork,
} from '../../../net/custom-networks';
import { trustedDestinations, type TrustedDestination } from '../../../net/inventory';
import type { NetPurpose } from '../../../net/purpose';

/** what the row can say about a host - the ledger's `pending` reads as "not decided yet" */
type EgressView = 'allowed' | 'blocked' | 'undecided';

const EGRESS_LABEL: Record<EgressView, string> = {
  allowed: 'allowed',
  blocked: 'blocked',
  undecided: 'not decided yet',
};

const EGRESS_DOT: Record<EgressView, string> = {
  allowed: 'bg-green-400',
  blocked: 'bg-hanko',
  undecided: 'bg-amber-400',
};

const egressViewOf = (state: NetEgressState | null, host: string | undefined): EgressView => {
  if (!host) {
    return 'undecided';
  }
  const record = state?.destinations[host];
  return record?.state === 'allowed'
    ? 'allowed'
    : record?.state === 'blocked'
      ? 'blocked'
      : 'undecided';
};

/** http(s)-only, so a typo'd scheme never becomes a stored endpoint. */
const parseHttpUrl = (raw: string): URL | undefined => {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One endpoint URL and the ledger decision on its host. `host` is absent when
 * the URL does not parse, in which case there is nothing to decide about.
 */
const EndpointDecisionRow = ({
  kind,
  url,
  state,
  onDecide,
}: {
  kind: string;
  url: string;
  state: EgressView;
  onDecide: (next: DestinationState) => void;
}) => {
  const host = hostOf(url);
  return (
    <div className='flex flex-col gap-1 border-t border-border-soft pt-2 first:border-t-0 first:pt-0'>
      <div className='flex items-center gap-1.5 text-label lowercase'>
        <span className='text-fg-muted'>{kind}</span>
        <span className={cn('h-1.5 w-1.5 rounded-full', EGRESS_DOT[state])} />
        <span className='text-fg-dim'>{EGRESS_LABEL[state]}</span>
      </div>
      <div className='break-all font-mono text-xs text-fg-dim'>{url}</div>
      {host && (
        <div className='flex items-center gap-3'>
          <button
            type='button'
            onClick={() => onDecide('blocked')}
            disabled={state === 'blocked'}
            className={cn(
              'text-label lowercase transition-colors hover:text-fg-high disabled:opacity-50',
              state === 'blocked' ? 'text-hanko' : 'text-fg-muted',
            )}
          >
            block
          </button>
          <button
            type='button'
            onClick={() => onDecide(state === 'allowed' ? 'pending' : 'allowed')}
            className={cn(
              'text-label lowercase transition-colors hover:text-fg-high',
              state === 'allowed' ? 'text-fg-muted' : 'text-zigner-gold',
            )}
          >
            {state === 'allowed' ? 'clear' : 'allow'}
          </button>
        </div>
      )}
    </div>
  );
};

/** allow/block for zafu's shipped rpc + rest hosts of one chain */
const ShippedHostDecisions = ({
  rpc,
  rest,
  label,
  egress,
  onDecide,
}: {
  rpc?: string;
  rest?: string;
  label: string;
  egress: NetEgressState | null;
  onDecide: (host: string, label: string, next: DestinationState) => Promise<void>;
}) => {
  if (!rpc && !rest) {
    return (
      <p className='text-label text-fg-dim lowercase'>zafu ships no endpoint for this chain.</p>
    );
  }
  return (
    <div className='flex flex-col gap-2'>
      {[
        ['rpc', rpc],
        ['rest', rest],
      ].map(([kind, url]) =>
        url ? (
          <EndpointDecisionRow
            key={kind}
            kind={kind!}
            url={url}
            state={egressViewOf(egress, hostOf(url))}
            onDecide={next => void onDecide(hostOf(url)!, `zafu's endpoint for ${label}`, next)}
          />
        ) : null,
      )}
    </div>
  );
};

/**
 * Every chain zafu knows under Penumbra, one row each: the rotating endpoint
 * pool, whether a live IBC channel to Penumbra exists, and the allow/block
 * decision on zafu's shipped hosts. Chains the node reports a channel for but
 * zafu has no config for get a plain row, so the channel set stays complete.
 */
const IbcChains = ({
  egress,
  onDecide,
}: {
  egress: NetEgressState | null;
  onDecide: (host: string, label: string, next: DestinationState) => Promise<void>;
}) => {
  const { data: live, isLoading } = useIbcChains();
  const known = Object.keys(COSMOS_CHAINS) as CosmosChainId[];
  const channelOpen = (chainId: string) =>
    isLoading ? undefined : Boolean(live?.some(c => c.chainId === chainId));
  const unconfigured = (live ?? []).filter(
    c => !Object.values(COSMOS_CHAINS).some(k => k.chainId === c.chainId),
  );

  return (
    <div className='flex flex-col gap-1.5'>
      {known.map(id => {
        const config = COSMOS_CHAINS[id];
        return (
          <TransparentChainEndpoints
            key={id}
            chainId={id}
            channelOpen={channelOpen(config.chainId)}
          >
            <ShippedHostDecisions
              rpc={config.rpcEndpoint}
              rest={config.restEndpoint}
              label={config.name}
              egress={egress}
              onDecide={onDecide}
            />
          </TransparentChainEndpoints>
        );
      })}
      {unconfigured.map(chain => (
        <div
          key={chain.chainId}
          className='flex items-center gap-2 border border-border-soft px-3 py-2'
        >
          <span className='flex-1 text-xs text-fg lowercase'>{chain.displayName}</span>
          <ChannelTag open />
          <span className='font-mono text-label text-fg-dim'>{chain.chainId}</span>
        </div>
      ))}
    </div>
  );
};

const OwnNetworks = ({
  networks,
  onRefresh,
}: {
  networks: CustomNetwork[];
  onRefresh: () => Promise<void>;
}) => {
  const [name, setName] = useState('');
  const [chainId, setChainId] = useState('');
  const [rpc, setRpc] = useState('');
  const [rest, setRest] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!name.trim()) {
      return setError('name is required.');
    }
    if (!chainId.trim()) {
      return setError('chain id is required.');
    }
    if (!parseHttpUrl(rpc)) {
      return setError('rpc must be an http(s) url.');
    }
    if (rest.trim() && !parseHttpUrl(rest)) {
      return setError('rest must be an http(s) url.');
    }
    setError(null);
    setSaving(true);
    try {
      await addCustomNetwork({
        name: name.trim(),
        chainId: chainId.trim(),
        rpc: rpc.trim(),
        rest: rest.trim() || undefined,
      });
      setName('');
      setChainId('');
      setRpc('');
      setRest('');
      await onRefresh();
    } catch {
      setError('could not save this network.');
    } finally {
      setSaving(false);
    }
  };

  const onRemove = async (id: string) => {
    await removeCustomNetwork(id);
    await onRefresh();
  };

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-2'>
        <input
          type='text'
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder='name (my noble node)'
          className='rounded-lg bg-input border border-border-soft px-3 py-2.5 text-xs focus:border-primary/50 focus:outline-none'
        />
        <input
          type='text'
          value={chainId}
          onChange={e => setChainId(e.target.value)}
          placeholder='chain id (noble-1)'
          className='rounded-lg bg-input border border-border-soft px-3 py-2.5 text-xs focus:border-primary/50 focus:outline-none'
        />
        <input
          type='text'
          value={rpc}
          onChange={e => setRpc(e.target.value)}
          placeholder='rpc (https://...)'
          className='rounded-lg bg-input border border-border-soft px-3 py-2.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
        />
        <input
          type='text'
          value={rest}
          onChange={e => setRest(e.target.value)}
          placeholder='rest (optional, https://...)'
          className='rounded-lg bg-input border border-border-soft px-3 py-2.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
        />
        {error && <p className='text-label text-hanko lowercase leading-snug'>{error}</p>}
        <div className='flex items-center justify-end'>
          <Button
            variant='primary'
            size='md'
            onClick={() => void onSubmit()}
            disabled={saving}
            className='text-xs'
          >
            {saving ? '...' : 'add network'}
          </Button>
        </div>
        <p className='text-label text-fg-dim lowercase leading-snug'>
          a node you run or trust. it joins the trusted egress inventory - one endpoint per chain,
          adding a second for the same chain id replaces the first.
        </p>
      </div>

      {networks.length > 0 && (
        <div className='flex flex-col gap-1.5 border-t border-border-soft pt-3'>
          {networks.map(network => (
            <div
              key={network.id}
              className='flex items-center gap-2 rounded-lg border border-border-soft px-3 py-2'
            >
              <div className='flex min-w-0 flex-1 flex-col'>
                <span className='text-xs text-fg lowercase'>{network.name}</span>
                <span className='break-all font-mono text-label text-fg-muted'>
                  {network.chainId} · {hostOf(network.rpc) ?? network.rpc}
                </span>
              </div>
              <button
                type='button'
                onClick={() => void onRemove(network.id)}
                className='shrink-0 text-fg-muted transition-colors hover:text-hanko'
                title='remove network'
              >
                <span className='i-ph-x h-3.5 w-3.5' />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** Shared load/refresh of the egress ledger, custom networks and inventory.
 *  Exported for settings-connections.tsx (the "everything zafu talks to"
 *  privacy screen), which needs the same egress + inventory + decide(). */
export const useDirectoryState = () => {
  const [egress, setEgress] = useState<NetEgressState | null>(null);
  const [networks, setNetworks] = useState<CustomNetwork[]>([]);
  const [destinations, setDestinations] = useState<TrustedDestination[]>([]);

  const refresh = useCallback(async () => {
    const [state, custom, known] = await Promise.all([
      readNetEgress(),
      readCustomNetworks(),
      trustedDestinations(),
    ]);
    setEgress(state);
    setNetworks(custom);
    setDestinations(known);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * A shipped endpoint may have no ledger record yet (nothing has contacted it
   * this install), and `setDestinationDecision` is a no-op on a missing record -
   * so record the first contact here, trusted, before applying the choice.
   */
  const decide = async (
    host: string,
    label: string,
    next: DestinationState,
    purpose: NetPurpose = 'chain-rpc',
  ) => {
    const state = await readNetEgress();
    if (!state.destinations[host]) {
      await noteDestination(host, { purpose, trusted: true, label });
    }
    await setDestinationDecision(host, next);
    await refresh();
  };

  return { egress, networks, destinations, refresh, decide };
};

/**
 * Penumbra's IBC side (lists 1 and 2): rendered inside the Penumbra network
 * panel, so a Zcash-only user never sees cosmos chains in their settings.
 */
export const PenumbraIbcDirectory = () => {
  const { egress, networks, refresh, decide } = useDirectoryState();

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-col gap-2'>
        <p className='text-label text-fg-muted lowercase'>ibc chains</p>
        <IbcChains egress={egress} onDecide={decide} />
      </div>

      <div className='flex flex-col gap-2 border-t border-border-soft pt-3'>
        <p className='text-label text-fg-muted lowercase'>your own networks</p>
        <OwnNetworks networks={networks} onRefresh={refresh} />
      </div>
    </div>
  );
};
