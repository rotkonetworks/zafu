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
import { useHyperliquidAccount, useHyperliquidAccounts } from '../../../hooks/hyperliquid';
import { SCAN_GAP } from '../../../hyperliquid/accounts';
import { Facts, Helper } from '../send/send-ui';
import { useNavigate } from 'react-router-dom';
import { PopupPath } from '../paths';
import type { SendLocationState } from '../send/prefill';
import { useExplain } from '../settings/settings-explain';
import { HomeScreen } from './home-screen';
import { DepositZecSheet, ZecMoveLines } from './hyperliquid-zec';
import { HOME_LOOK } from './look';

/**
 * An account made elsewhere on another key path: one extra account beside the
 * indexed ones, never in place of them, so no indexed account is ever out of reach.
 */
const PathSheet = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const { customPath, setCustomPath } = useHyperliquidAccounts();
  const [draft, setDraft] = useState<string>();
  const text = (draft ?? customPath ?? '').trim();
  const valid = isBip32Path(text);
  const close = (next: string | undefined) => {
    void setCustomPath(next).then(() => {
      setDraft(undefined);
      onOpenChange(false);
    });
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title='imported path'
      footer={
        <div className='flex gap-2'>
          <Button
            variant='secondary'
            className='w-[130px]'
            disabled={!customPath}
            onClick={() => close(undefined)}
          >
            remove it
          </Button>
          <Button
            className='grow'
            disabled={!valid || text === customPath}
            onClick={() => close(text)}
          >
            add this account
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
          value={draft ?? customPath ?? ''}
          onChange={e => setDraft(e.target.value)}
          placeholder={HYPERLIQUID_DEFAULT_PATH}
          variant={text && !valid ? 'warn' : 'default'}
          spellCheck={false}
          className='font-mono'
        />
        <Helper warn={!!text && !valid}>
          {text && !valid
            ? `a path looks like ${HYPERLIQUID_DEFAULT_PATH}`
            : 'it joins your accounts as one more · the others stay as they are'}
        </Helper>
      </div>
    </Sheet>
  );
};

/** find this seed's accounts again, from the seed alone: asked for, never in the background */
const LookSheet = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const { lookForAccounts } = useHyperliquidAccounts();
  const [state, setState] = useState<'idle' | 'looking' | 'failed' | number>('idle');
  const look = () => {
    setState('looking');
    lookForAccounts().then(setState, () => setState('failed'));
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title='look for accounts'
      footer={
        <Button className='w-full' loading={state === 'looking'} onClick={look}>
          look now
        </Button>
      }
    >
      <p className='text-sm leading-relaxed text-fg'>
        zafu asks hyperliquid about this wallet&apos;s accounts in order, one at a time, and stops
        after {SCAN_GAP} in a row that were never used.
      </p>
      <StatusSlot tone={state === 'failed' ? 'warn' : 'info'} icon='i-ph-info'>
        {state === 'failed'
          ? 'hyperliquid did not answer, so zafu stopped · nothing was changed, please try again'
          : typeof state === 'number'
            ? state < 1
              ? 'no other account was ever used'
              : `found accounts up to account ${state} · they are in your account list now`
            : "hyperliquid's api sees these addresses asked together from this connection, which tells it they are one wallet"}
      </StatusSlot>
    </Sheet>
  );
};

export const HyperliquidHome = ({ nudge }: { nudge?: ReactNode }) => {
  const { keyId, name, address, balances } = useHyperliquidAccount();
  const { customPath } = useHyperliquidAccounts();
  const [lookOpen, setLookOpen] = useState(false);
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
      {address && (
        <ZecMoveLines wallet={keyId} account={address} onLanded={() => void balances.refetch()} />
      )}
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
          label={`${name} · address`}
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
          type='screen'
          label='look for accounts'
          description='find accounts of this seed again'
          onPress={() => setLookOpen(true)}
        />
        <Row
          type='value'
          label='advanced'
          description='an account on another key path'
          value={customPath ?? 'none'}
          onPress={() => setPathOpen(true)}
        />
      </RowGroup>
      <PathSheet open={pathOpen} onOpenChange={setPathOpen} />
      <LookSheet open={lookOpen} onOpenChange={setLookOpen} />
      {address && (
        <DepositZecSheet
          unit={{ wallet: keyId, account: address, name }}
          open={zecOpen}
          onOpenChange={setZecOpen}
        />
      )}
      {sheet}
    </HomeScreen>
  );
};
