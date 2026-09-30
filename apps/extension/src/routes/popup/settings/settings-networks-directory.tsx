/**
 * The networks directory.
 *
 * Three honest lists, in the order a user cares about:
 *
 *  1. chains with an open channel to penumbra - the real "you can bridge to
 *     these" set, each with zafu's shipped rpc/rest and its current egress
 *     decision, blockable/allowable inline;
 *  2. the user's own networks - a node they run or trust, added by hand, which
 *     then feeds the trusted egress inventory;
 *  3. everything else the wallet may talk to (the shipped + configured hosts),
 *     folded away so it does not dominate the screen.
 *
 * The egress decision lives in the ledger (`net/ledger.ts`), not here: this
 * screen is a view that re-reads after every mutation.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { cn } from '@repo/ui/lib/utils';
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { useIbcChains } from '../../../hooks/ibc-chains';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { hostOf, type DestinationState, type NetEgressState } from '../../../net/destination';
import { noteDestination, readNetEgress, setDestinationDecision } from '../../../net/ledger';
import {
  addCustomNetwork,
  readCustomNetworks,
  removeCustomNetwork,
  type CustomNetwork,
} from '../../../net/custom-networks';
import { trustedDestinations, type TrustedDestination } from '../../../net/inventory';
import { NET_PURPOSE_LABEL, type NetPurpose } from '../../../net/purpose';

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
  if (!host) return 'undecided';
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

const ChainsWithChannel = ({
  egress,
  onDecide,
}: {
  egress: NetEgressState | null;
  onDecide: (host: string, label: string, next: DestinationState) => Promise<void>;
}) => {
  const { data: chains, isLoading } = useIbcChains();

  if (isLoading) {
    return <p className='text-label text-fg-dim lowercase'>loading channels…</p>;
  }
  if (!chains || chains.length === 0) {
    return (
      <p className='text-label text-fg-dim lowercase leading-snug'>
        no open channels to penumbra right now.
      </p>
    );
  }

  return (
    <div className='flex flex-col gap-1.5'>
      {chains.map(chain => {
        // zafu's shipped rpc/rest for this chain id - absent means it ships none
        const config = Object.values(COSMOS_CHAINS).find(c => c.chainId === chain.chainId);
        const rpc = config?.rpcEndpoint;
        const rest = config?.restEndpoint;
        return (
          <div key={chain.chainId} className='rounded-lg border border-border-soft px-3 py-2'>
            <div className='flex items-baseline gap-2'>
              <span className='flex-1 text-xs text-fg lowercase'>{chain.displayName}</span>
              <span className='break-all font-mono text-label text-fg-muted'>{chain.chainId}</span>
            </div>
            <div className='mt-2 flex flex-col gap-2'>
              {rpc && (
                <EndpointDecisionRow
                  kind='rpc'
                  url={rpc}
                  state={egressViewOf(egress, hostOf(rpc))}
                  onDecide={next =>
                    void onDecide(hostOf(rpc)!, `zafu's endpoint for ${chain.displayName}`, next)
                  }
                />
              )}
              {rest && (
                <EndpointDecisionRow
                  kind='rest'
                  url={rest}
                  state={egressViewOf(egress, hostOf(rest))}
                  onDecide={next =>
                    void onDecide(hostOf(rest)!, `zafu's endpoint for ${chain.displayName}`, next)
                  }
                />
              )}
              {!rpc && !rest && (
                <p className='text-label text-fg-dim lowercase'>
                  zafu ships no endpoint for this chain.
                </p>
              )}
            </div>
          </div>
        );
      })}
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
    if (!name.trim()) return setError('name is required.');
    if (!chainId.trim()) return setError('chain id is required.');
    if (!parseHttpUrl(rpc)) return setError('rpc must be an http(s) url.');
    if (rest.trim() && !parseHttpUrl(rest)) return setError('rest must be an http(s) url.');
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
            variant='gradient'
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

/** everything the wallet already has a reason to contact, folded away. */
const KnownDestinations = ({ destinations }: { destinations: TrustedDestination[] }) => {
  const [open, setOpen] = useState(false);

  const grouped = destinations.reduce<Map<NetPurpose, TrustedDestination[]>>((acc, dest) => {
    for (const purpose of dest.purposes.length ? dest.purposes : (['other'] as NetPurpose[])) {
      const list = acc.get(purpose) ?? [];
      list.push(dest);
      acc.set(purpose, list);
    }
    return acc;
  }, new Map());

  return (
    <div className='border-t border-border-soft pt-2'>
      <button
        type='button'
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className='flex w-full items-center gap-1 text-label text-fg-muted lowercase transition-colors hover:text-fg-high'
      >
        <span
          className={cn('i-ph-caret-right h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
        />
        everything else the wallet may talk to ({destinations.length})
      </button>
      {open && (
        <div className='mt-3 flex flex-col gap-3'>
          {[...grouped.entries()].map(([purpose, list]) => (
            <div key={purpose} className='flex flex-col gap-1'>
              <span className='text-label text-fg-muted lowercase'>
                {NET_PURPOSE_LABEL[purpose]}
              </span>
              {list.map(dest => (
                <div key={`${purpose}-${dest.host}`} className='flex items-baseline gap-2'>
                  <span className='flex-1 text-label text-fg-dim lowercase'>{dest.label}</span>
                  <span className='break-all font-mono text-label text-fg-muted'>{dest.host}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const NetworksDirectory = () => {
  const penumbraEnabled = useStore(selectEnabledNetworks).includes('penumbra');
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
  const decide = async (host: string, label: string, next: DestinationState) => {
    const state = await readNetEgress();
    if (!state.destinations[host]) {
      await noteDestination(host, { purpose: 'chain-rpc', trusted: true, label });
    }
    await setDestinationDecision(host, next);
    await refresh();
  };

  return (
    <div className='flex flex-col gap-4'>
      {penumbraEnabled && (
        <div className='flex flex-col gap-2 border-b border-border-soft pb-3'>
          <p className='text-label text-fg-muted lowercase'>
            chains with an open channel to penumbra
          </p>
          <ChainsWithChannel egress={egress} onDecide={decide} />
        </div>
      )}

      <div className='flex flex-col gap-2'>
        <p className='text-label text-fg-muted lowercase'>your own networks</p>
        <OwnNetworks networks={networks} onRefresh={refresh} />
      </div>

      <KnownDestinations destinations={destinations} />
    </div>
  );
};
