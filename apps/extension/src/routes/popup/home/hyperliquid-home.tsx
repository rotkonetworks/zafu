/**
 * Hyperliquid's home: the USDC that can move, per account, the address, and
 * behind a quiet row the key path for someone whose account sits elsewhere.
 * Balances are read on opening and on refresh, never on a timer.
 */

import { useState, type ReactNode } from 'react';
import { shorten } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { microToUsdc, zatToZec } from '@repo/wallet/networks/hyperliquid/client';
import { HYPERLIQUID_DEFAULT_PATH, isBip32Path } from '@repo/wallet/networks/hyperliquid/derive';
import type { BalanceView } from '../../../components/wallet/balance-hero';
import { useHyperliquidAccount, useHyperliquidPath } from '../../../hooks/hyperliquid';
import { Facts, Helper } from '../send/send-ui';
import { useNavigate } from 'react-router-dom';
import { PopupPath } from '../paths';
import type { SendLocationState } from '../send/prefill';
import { useExplain } from '../settings/settings-explain';
import { HomeScreen } from './home-screen';
import { DepositZecSheet, ZecMoveLines } from './hyperliquid-zec';
import { HOME_LOOK } from './look';

/** the key path, entered by hand: only for an account that already lives on another path */
const PathSheet = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const { path, save } = useHyperliquidPath();
  const [draft, setDraft] = useState<string>();
  const text = (draft ?? path ?? '').trim();
  const valid = isBip32Path(text);
  const close = (next: string) => {
    void save(next).then(() => {
      setDraft(undefined);
      onOpenChange(false);
    });
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title='key path'
      footer={
        <div className='flex gap-2'>
          <Button
            variant='secondary'
            className='w-[130px]'
            disabled={path === HYPERLIQUID_DEFAULT_PATH}
            onClick={() => close(HYPERLIQUID_DEFAULT_PATH)}
          >
            use default
          </Button>
          <Button className='grow' disabled={!valid || text === path} onClick={() => close(text)}>
            use this path
          </Button>
        </div>
      }
    >
      <div className='flex flex-col gap-1.5'>
        <label htmlFor='hyperliquid-path' className='text-xs text-fg-muted'>
          for a hyperliquid account made elsewhere, on another path
        </label>
        <Input
          id='hyperliquid-path'
          value={draft ?? path ?? ''}
          onChange={e => setDraft(e.target.value)}
          placeholder={HYPERLIQUID_DEFAULT_PATH}
          variant={text && !valid ? 'warn' : 'default'}
          spellCheck={false}
          className='font-mono'
        />
        <Helper warn={!!text && !valid}>
          {text && !valid
            ? `a path looks like ${HYPERLIQUID_DEFAULT_PATH}`
            : 'changing it shows another address · funds stay where they are'}
        </Helper>
      </div>
    </Sheet>
  );
};

export const HyperliquidHome = ({ nudge }: { nudge?: ReactNode }) => {
  const { keyId, path, address, balances } = useHyperliquidAccount();
  const [pathOpen, setPathOpen] = useState(false);
  const [zecOpen, setZecOpen] = useState(false);
  const navigate = useNavigate();
  const { explainProps, sheet } = useExplain();
  const { copied, copy } = useCopy();

  if (!keyId) {
    return (
      <div className='p-4'>
        <StatusSlot icon='i-ph-info'>
          hyperliquid needs a seed wallet in zafu for now · this wallet&apos;s keys stay on its
          signer, so there is no address to show here yet
        </StatusSlot>
      </div>
    );
  }

  const b = balances.data;
  const view: BalanceView = b
    ? balances.isFetching
      ? 'partial'
      : 'ready'
    : balances.isError
      ? 'error'
      : 'loading';
  return (
    <HomeScreen
      look={HOME_LOOK.hyperliquid}
      view={view}
      amount={b ? microToUsdc(b.perp + b.spot) : ''}
      spendable={!!b && b.perp + b.spot + b.uzec > 0n}
      watermark={false}
    >
      {nudge}
      {balances.isError && (
        <StatusSlot
          tone='warn'
          icon='i-ph-warning'
          action={{ label: 'try again', onClick: () => void balances.refetch() }}
        >
          zafu could not reach hyperliquid just now · nothing has changed
        </StatusSlot>
      )}
      {address && <ZecMoveLines account={address} onLanded={() => void balances.refetch()} />}
      {b && (
        <Facts
          rows={[
            ['perp account', `${microToUsdc(b.perp)} usdc`],
            ['spot account', `${microToUsdc(b.spot)} usdc`],
            ['spot account · zec', `${zatToZec(b.uzec)} uzec`],
          ]}
        />
      )}
      <RowGroup>
        <Row
          type='screen'
          label='deposit zec'
          description='from your zcash wallet, through unit'
          disabled={!address}
          onPress={() => setZecOpen(true)}
        />
        <Row
          type='screen'
          label='withdraw zec'
          description='to a fresh public address of yours'
          disabled={!b || b.uzec === 0n}
          onPress={() =>
            navigate(PopupPath.SEND, {
              state: { hyperliquidZec: true } satisfies SendLocationState,
            })
          }
        />
        <Row
          type='value'
          label='who keeps what'
          description="it moves only with your key · unit's guardians keep the zec"
          {...explainProps('hyperliquid.custody')}
          onPress={() => explainProps('hyperliquid.custody').onExplain?.('who keeps what')}
        />
      </RowGroup>
      <RowGroup>
        <Row
          type='value'
          label='address'
          description={copied ? 'copied' : 'public · tap to copy'}
          value={address ? shorten(address, 6, 4) : ''}
          disabled={!address}
          onPress={() => address && copy(address)}
        />
        <Row
          type='screen'
          label='refresh'
          description='read when this opens, never in the background'
          disabled={balances.isFetching}
          onPress={() => void balances.refetch()}
        />
        <Row
          type='value'
          label='advanced'
          description='key path'
          value={path === HYPERLIQUID_DEFAULT_PATH ? 'default' : path}
          onPress={() => setPathOpen(true)}
        />
      </RowGroup>
      <PathSheet open={pathOpen} onOpenChange={setPathOpen} />
      {address && <DepositZecSheet account={address} open={zecOpen} onOpenChange={setZecOpen} />}
      {sheet}
    </HomeScreen>
  );
};
