/**
 * The unshielded side of a penumbra token: a shield button on home once a
 * check found it on a deposit address, and in the token sheet a line per
 * chain it can sit on. Nothing asks a node until a line's check is tapped,
 * and a tap asks only that chain. A chain's first tap asks which of its
 * nodes may be asked (saved as its node list in settings), and whether to
 * check on its own from then on; after that a tap just checks.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { getCosmosChain, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { defaultRpcPool, getRpcPool, setRpcPool } from '../../../hooks/transparent-rpc';
import { useTransparentHoldings, type Holding } from '../../../hooks/transparent-holdings';
import { refreshEgress } from '../../../net/egress';
import { ago } from '../../../transparent/chain-check';
import { useStore } from '../../../state';
import { UnshieldedLine, type LineAction } from '../../../components/wallet/balance-rows';
import { useOpenIntent } from '../../../hooks/open-link';

const chainName = (c: CosmosChainId) => getCosmosChain(c).name.toLowerCase();

interface Nodes {
  all: string[];
  on: Set<string>;
}

/** the first check: which nodes may be asked, and whether to keep checking on its own */
const AskSheet = ({
  chains,
  open,
  onOpenChange,
  onAgree,
  onAgreed,
}: {
  chains: CosmosChainId[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAgree: () => void;
  /** remember that this chain's nodes may be asked */
  onAgreed: (c: CosmosChainId) => Promise<void>;
}) => {
  const setSetting = useStore(s => s.privacy.setSetting);
  const [nodes, setNodes] = useState<Partial<Record<CosmosChainId, Nodes>>>({});
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    void Promise.all(
      chains.map(async c => {
        const pool = await getRpcPool(c);
        const row: [CosmosChainId, Nodes] = [
          c,
          { all: [...new Set([...defaultRpcPool(c), ...pool])], on: new Set(pool) },
        ];
        return row;
      }),
    ).then(rows => setNodes(Object.fromEntries(rows)));
  }, [open, chains]);

  const flip = (c: CosmosChainId, url: string) =>
    setNodes(n => {
      const on = new Set(n[c]?.on);
      if (!on.delete(url)) {
        on.add(url);
      }
      return { ...n, [c]: { all: n[c]?.all ?? [], on } };
    });
  const ready = chains.every(c => (nodes[c]?.on.size ?? 0) > 0);

  const agree = async () => {
    for (const c of chains) {
      await onAgreed(c);
      const picked = nodes[c]?.all.filter(u => nodes[c]?.on.has(u)) ?? [];
      // the shipped list stays unpinned, so a later change to it still applies
      const shipped = JSON.stringify(picked) === JSON.stringify(defaultRpcPool(c));
      await setRpcPool(c, shipped ? [] : picked);
    }
    await setSetting('enableTransparentBalances', true);
    await setSetting('autoCheckTransparent', auto);
    await refreshEgress();
    onAgree();
  };

  const box = 'mt-0.5 h-4 w-4 shrink-0 accent-[var(--zigner-gold)]';
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='check transparent balances'>
      <p className='text-xs leading-relaxed text-fg-muted'>
        zafu asks these nodes from your ip. each address goes to a different one.
      </p>
      <div className='-mx-4 flex min-h-0 flex-col gap-3 overflow-y-auto px-4'>
        {chains.map(c => (
          <div key={c} className='flex flex-col gap-1.5'>
            <span className='text-[11px] text-fg-dim'>{chainName(c)}</span>
            {(nodes[c]?.all ?? []).map(url => (
              <label key={url} className='flex cursor-pointer items-start gap-2.5 text-xs text-fg'>
                <input
                  type='checkbox'
                  checked={nodes[c]?.on.has(url) ?? false}
                  onChange={() => flip(c, url)}
                  className={box}
                />
                <span className='break-all font-mono'>{url.replace(/^https?:\/\//, '')}</span>
              </label>
            ))}
          </div>
        ))}
        <label className='flex cursor-pointer items-start gap-2.5 text-xs text-fg'>
          <input
            type='checkbox'
            checked={auto}
            onChange={e => setAuto(e.target.checked)}
            className={box}
          />
          <span>check on its own each time the balance opens</span>
        </label>
      </div>
      <Button className='w-full' disabled={!ready} onClick={() => void agree()}>
        check
      </Button>
      <Button variant='quiet' className='w-full' onClick={() => onOpenChange(false)}>
        not now
      </Button>
    </Sheet>
  );
};

/** several deposit addresses holding one asset read as their first, plus a count */
const amountOf = (held: Holding[]) =>
  `${held[0]!.asset.formatted}${held.length > 1 ? ` +${held.length - 1}` : ''}`;

/** chains whose nodes the user agreed may be asked (a backed-up setting) */
const useAgreedChains = () => {
  const queryClient = useQueryClient();
  const { data: agreed = [] } = useQuery({
    queryKey: ['transparentAgreed'],
    queryFn: async () => (await localExtStorage.get('transparentAgreed')) ?? [],
  });
  return {
    agreed,
    add: async (c: CosmosChainId) => {
      const next = [...new Set([...agreed, c])];
      queryClient.setQueryData(['transparentAgreed'], next);
      await localExtStorage.set('transparentAgreed', next);
    },
  };
};

/** a token's transparent side: home's shield button, the sheet's chain lines */
export const useTransparent = () => {
  const open = useOpenIntent();
  const t = useTransparentHoldings();
  const { agreed, add } = useAgreedChains();
  const auto = useStore(s => s.privacy.settings.autoCheckTransparent);
  const [asking, setAsking] = useState<CosmosChainId>();
  const { check } = t;

  // opted in to checking on its own: each agreed chain, once each time the balance opens
  useEffect(() => {
    if (auto) {
      t.chains.filter(c => agreed.includes(c)).forEach(check);
    }
    // the open, not every render, is what asks
  }, [auto, agreed.length, t.chains.length]);

  const press = (c: CosmosChainId) => (agreed.includes(c) ? check(c) : setAsking(c));
  const shield = (h: Holding) =>
    open({ kind: 'move', move: { action: 'shield', chain: h.chainId, index: h.index } });
  const heldOf = (symbol: string) => t.holdings.get(symbol.toLowerCase()) ?? [];

  /** home: one small shield button, only once a check found this token */
  const shieldButton = (symbol: string): LineAction | undefined => {
    const h = heldOf(symbol)[0];
    return h
      ? {
          icon: 'i-ph-shield',
          label: `shield ${symbol.toLowerCase()} from ${chainName(h.chainId)}`,
          onPress: () => shield(h),
        }
      : undefined;
  };

  /** the token sheet: each chain this token can sit on, its last check and what was found */
  const chainLines = (symbol: string): ReactNode => {
    const key = symbol.toLowerCase();
    const chains = [...new Set([...t.chainsFor(key), ...heldOf(key).map(h => h.chainId)])];
    return chains.map(c => {
      const held = heldOf(key).filter(h => h.chainId === c);
      const { status, at } = t.statusOf(c);
      const said = held.length
        ? `${amountOf(held)} · ${chainName(c)}`
        : `${chainName(c)} · ${
            {
              unchecked: 'not checked',
              checking: 'checking',
              unanswered: "a node didn't answer",
              checked: `none · ${ago(at)}`,
            }[status]
          }`;
      return (
        <UnshieldedLine
          key={c}
          found={held.length > 0}
          actions={[
            {
              icon: 'i-lucide-refresh-cw',
              label: `check ${chainName(c)}`,
              onPress: () => press(c),
              busy: status === 'checking',
            },
          ]}
        >
          {said}
          {held.length && getCosmosChain(c).deprecation ? ' · closing, please move it' : ''}
        </UnshieldedLine>
      );
    });
  };

  return {
    shieldButton,
    chainLines,
    /** what a check found of a token, across its deposit addresses */
    found: (symbol: string) => {
      const held = heldOf(symbol);
      return held.length ? amountOf(held) : undefined;
    },
    /** tokens found only on a deposit address, nothing shielded */
    onlyThere: (shown: string[]) => {
      const have = new Set(shown.map(s => s.toLowerCase()));
      return [...t.holdings.keys()].filter(s => !have.has(s));
    },
    sheet: (
      <AskSheet
        chains={asking ? [asking] : []}
        open={!!asking}
        onOpenChange={o => !o && setAsking(undefined)}
        onAgreed={add}
        onAgree={() => {
          const c = asking;
          setAsking(undefined);
          if (c) {
            check(c);
          }
        }}
      />
    ),
  };
};
