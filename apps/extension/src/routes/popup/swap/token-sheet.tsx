/**
 * The swap token picker: chain first, then the coin, with one search field
 * that finds either ("usdc base"). Logos are bundled (state/swap/icons.ts);
 * a token or chain without one gets a monogram.
 */

import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import type { SwapToken } from '../../../state/swap/provider';
import { CHAIN_ICONS, TOKEN_ICONS } from '../../../state/swap/icons';
import { chainName, chainsOf, searchTokens } from '../../../state/swap/tokens';

const Logo = ({ src, label, size }: { src?: string; label: string; size: string }) =>
  src ? (
    <img src={src} alt='' className={`${size} shrink-0 object-cover`} />
  ) : (
    <span
      className={`${size} flex shrink-0 items-center justify-center border border-surface-border-soft text-[10px] text-fg-muted uppercase`}
      aria-hidden='true'
    >
      {label.slice(0, 1)}
    </span>
  );

/** the coin's logo with its chain as a corner badge, so usdc on base reads at a glance */
export const TokenLogo = ({ token }: { token: SwapToken }) => (
  <span className='relative shrink-0'>
    <Logo src={TOKEN_ICONS[token.symbol.toLowerCase()]} label={token.symbol} size='size-6' />
    <span className='absolute -bottom-1 -right-1 bg-canvas p-px'>
      <Logo src={CHAIN_ICONS[token.chain]} label={token.chain} size='size-3' />
    </span>
  </span>
);

export function TokenSheet({
  title,
  open,
  onOpenChange,
  tokens,
  loading,
  onPick,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tokens: readonly SwapToken[];
  loading: boolean;
  onPick: (token: SwapToken) => void;
}) {
  const [query, setQuery] = useState('');
  const [chain, setChain] = useState<string>();
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setQuery('');
      setChain(undefined);
    }
  };
  const searching = query.trim() !== '';
  const coins = searching || chain ? searchTokens(tokens, query, chain) : [];

  const empty = (text: string) => <p className='py-6 text-center text-xs text-fg-muted'>{text}</p>;

  return (
    <Sheet
      open={open}
      onOpenChange={close}
      title={chain ? `${title} · ${chainName(chain)}` : title}
    >
      <Input
        placeholder='search coin or chain, e.g. usdc base'
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      {chain && (
        <Button
          variant='quiet'
          size='sm'
          onClick={() => setChain(undefined)}
          className='self-start px-0'
        >
          <span className='i-ph-caret-left size-3.5' aria-hidden='true' />
          all chains
        </Button>
      )}
      <div className='min-h-0 overflow-y-auto'>
        {loading && tokens.length === 0 ? (
          empty('reading the routes')
        ) : searching || chain ? (
          coins.length > 0 ? (
            <RowGroup>
              {coins.map(t => (
                <Row
                  key={`${t.symbol}@${t.chain}`}
                  type='screen'
                  media={<TokenLogo token={t} />}
                  label={t.symbol.toLowerCase()}
                  description={chainName(t.chain)}
                  onPress={() => {
                    onPick(t);
                    close(false);
                  }}
                />
              ))}
            </RowGroup>
          ) : (
            empty('nothing matches that')
          )
        ) : tokens.length > 0 ? (
          <RowGroup>
            {chainsOf(tokens).map(({ chain: c, count }) => (
              <Row
                key={c}
                type='value'
                media={<Logo src={CHAIN_ICONS[c]} label={c} size='size-6' />}
                label={chainName(c)}
                value={String(count)}
                onPress={() => setChain(c)}
              />
            ))}
          </RowGroup>
        ) : (
          empty('no tokens available')
        )}
      </div>
    </Sheet>
  );
}
