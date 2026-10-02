/**
 * The unshielded side of the penumbra assets list: a quiet line under each
 * asset a deposit address can hold, and a row of its own for an asset found
 * only there. Nothing asks a node until a line is tapped. The first tap asks
 * which nodes may be asked (saved as that chain's node list in settings), and
 * whether to check on its own from then on; after that a tap just checks.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { defaultRpcPool, getRpcPool, setRpcPool } from '../../../hooks/transparent-rpc';
import { useTransparentHoldings, type Holding } from '../../../hooks/transparent-holdings';
import { refreshEgress } from '../../../net/egress';
import { ago } from '../../../transparent/chain-check';
import { useStore } from '../../../state';
import { BalanceRow, Tile, UnshieldedLine } from '../../../components/wallet/balance-rows';
import { PopupPath } from '../paths';

const chainName = (c: CosmosChainId) => COSMOS_CHAINS[c].name.toLowerCase();

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
}: {
  chains: CosmosChainId[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAgree: () => void;
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

/**
 * Lines for the penumbra assets list. `lineFor(symbol)` is the line under a
 * shielded asset's row; `rows(shown)` are the rows for assets found only on a
 * deposit address (or, before anything is known, one row to check from).
 */
export const useTransparentLines = () => {
  const navigate = useNavigate();
  const t = useTransparentHoldings();
  const agreed = useStore(s => s.privacy.settings.enableTransparentBalances);
  const auto = useStore(s => s.privacy.settings.autoCheckTransparent);
  const [asking, setAsking] = useState(false);
  const { check } = t;

  // opted in to checking on its own: once each time the balance opens
  useEffect(() => {
    if (agreed && auto) {
      check();
    }
    // the open, not every render, is what asks
  }, [agreed, auto, t.chains.length]);

  const press = () => (agreed ? check() : setAsking(true));
  const shield = (h: Holding) =>
    navigate(PopupPath.SEND, {
      state: { cosmosChain: h.chainId, cosmosAccountIndex: h.index, cosmosIntent: 'shield' },
    });

  const line = (symbol: string): ReactNode => {
    const held = t.holdings.get(symbol);
    if (held?.length) {
      const h = held[0]!;
      const gone = COSMOS_CHAINS[h.chainId].deprecation;
      return (
        <UnshieldedLine found action={{ label: 'shield', onPress: () => shield(h) }}>
          {amountOf(held)} transparent · on {chainName(h.chainId)}
          {gone ? ' · closing, please move it' : ''}
        </UnshieldedLine>
      );
    }
    const said = {
      unchecked: 'transparent · not checked',
      checking: 'transparent · checking',
      unanswered: "transparent · a node didn't answer",
      checked: `transparent · none · checked ${ago(t.at)}`,
    }[t.status];
    return (
      <UnshieldedLine
        action={{
          label: t.status === 'unanswered' ? 'try again' : 'check',
          onPress: press,
          busy: t.status === 'checking',
        }}
      >
        {said}
      </UnshieldedLine>
    );
  };

  return {
    /** some chain is in use, so there is an unshielded side to show */
    active: t.chains.length > 0,
    lineFor: (symbol: string): ReactNode =>
      t.chains.length && t.symbols.has(symbol.toLowerCase()) ? line(symbol.toLowerCase()) : null,
    rows: (shown: string[]): ReactNode => {
      if (!t.chains.length) {
        return null;
      }
      const have = new Set(shown.map(s => s.toLowerCase()));
      const only = [...t.holdings.keys()].filter(s => !have.has(s));
      const lined = shown.some(s => t.symbols.has(s.toLowerCase()));
      return (
        <>
          {only.map(s => (
            <BalanceRow
              key={s}
              tile={<Tile tone='quiet'>{s.slice(0, 2)}</Tile>}
              label={t.holdings.get(s)![0]!.asset.symbol}
              tag='nothing shielded yet'
              amount='0'
              below={line(s)}
            />
          ))}
          {/* nothing to hang a line on yet: one row to check from */}
          {!lined && !only.length && (
            <BalanceRow
              tile={<Tile tone='quiet'>tr</Tile>}
              label='transparent'
              tag='your deposit addresses'
              below={line('')}
            />
          )}
        </>
      );
    },
    sheet: (
      <AskSheet
        chains={t.chains}
        open={asking}
        onOpenChange={setAsking}
        onAgree={() => {
          setAsking(false);
          check();
        }}
      />
    ),
  };
};
