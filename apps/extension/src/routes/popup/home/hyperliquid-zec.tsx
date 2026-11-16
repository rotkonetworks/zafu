/**
 * ZEC on the Hyperliquid home: starting a deposit from the zcash wallet
 * (the payment itself is zcash's own send, to Unit's verified address), and
 * one line per move in flight, read from Unit.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { UNIT_MIN_ZEC } from '@repo/wallet/networks/hyperliquid/api';
import { zatToZec, zecToZat } from '@repo/wallet/networks/hyperliquid/client';
import {
  unitDepositAddress,
  unitZecEstimate,
  unitZecOperations,
} from '@repo/wallet/networks/hyperliquid/unit';
import { PendingLine } from '../../../components/in-flight-card';
import { payableTransparentAddress } from '../../../ledger/address';
import { useStore } from '../../../state';
import { selectSetActiveNetwork } from '../../../state/keyring';
import { selectZcashIsMainnet } from '../../../state/wallets';
import { zecMoveStatus, zecMoves, type ZecMove } from '../../../hyperliquid/zec-moves';
import { PopupPath } from '../paths';
import { AmountField } from '../send/send-fields';
import { Facts } from '../send/send-ui';
import type { SendLocationState } from '../send/prefill';

const MIN = zatToZec(UNIT_MIN_ZEC);

/** amount first; the address is asked of Unit, and verified, only on continue */
export const DepositZecSheet = ({
  account,
  open,
  onOpenChange,
}: {
  account: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const navigate = useNavigate();
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const zcashOn = useStore(s => s.keyRing.enabledNetworks.includes('zcash'));
  const mainnet = useStore(selectZcashIsMainnet);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const estimate = useQuery({
    queryKey: ['unitZecEstimate'],
    queryFn: () => unitZecEstimate(),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const valid = /^(\d+\.?\d{0,8}|\.\d{1,8})$/.test(amount);
  const short = valid && zecToZat(amount) < UNIT_MIN_ZEC;
  const blocked = !zcashOn || !mainnet;

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const to = await unitDepositAddress(account, tex => payableTransparentAddress(tex, true));
      // zcash pays it: its own send, review and tracker, from the shielded pool
      await setActiveNetwork('zcash');
      const state: SendLocationState = {
        prefillRecipient: to,
        prefillAmount: amount,
        unitAccount: account,
      };
      navigate(PopupPath.SEND, { state });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unit did not answer');
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title='deposit zec'
      footer={
        <Button
          className='w-full'
          loading={busy}
          disabled={blocked || !valid || short}
          onClick={() => void go()}
        >
          continue in zcash
        </Button>
      }
    >
      <AmountField
        id='deposit-zec-amount'
        value={amount}
        onChange={setAmount}
        unit='zec'
        warn={short}
        helper={short ? `unit takes ${MIN} zec or more · less would not arrive` : undefined}
      />
      <Facts
        rows={[
          ['paid from', 'your zcash wallet · shielded'],
          ['arrives as', 'uzec in your spot account'],
          ['minimum', `${MIN} zec`],
          [
            "unit's fee",
            estimate.data ? `${zatToZec(estimate.data.depositFeeZat)} zec` : 'a network fee',
          ],
          ['time', estimate.data ? `about ${estimate.data.depositEta}` : 'about two hours'],
        ]}
      />
      {(blocked || error) && (
        <StatusSlot tone='warn' icon='i-ph-warning'>
          {error
            ? `${error} · nothing was sent`
            : zcashOn
              ? 'unit takes mainnet zec · please switch zcash off its testnet first'
              : 'please turn zcash on first · the zec is paid from it'}
        </StatusSlot>
      )}
    </Sheet>
  );
};

/** while a move is in flight and this is on screen, Unit is asked again this often */
const POLL_MS = 60_000;

/** one line per zec move in flight; a move Unit calls done is forgotten */
export const ZecMoveLines = ({ account, onLanded }: { account: string; onLanded: () => void }) => {
  const [moves, setMoves] = useState<ZecMove[]>([]);
  useEffect(() => {
    const read = () => void zecMoves.read().then(setMoves);
    read();
    return zecMoves.onChange(read);
  }, []);
  const mine = moves.filter(m => m.account === account);
  const ops = useQuery({
    queryKey: ['unitZecOperations', account],
    queryFn: () => unitZecOperations(account),
    enabled: mine.length > 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchInterval: mine.length > 0 ? POLL_MS : false,
    retry: false,
    structuralSharing: false, // bigint amounts
  });
  const landed = mine.filter(m => {
    const s = zecMoveStatus(m, ops.data);
    return s.over && !s.failed;
  });
  useEffect(() => {
    if (landed.length) {
      void Promise.all(landed.map(m => zecMoves.forget(m.id))).then(onLanded);
    }
  }, [landed.map(m => m.id).join()]);

  return (
    <>
      {mine.map(m => {
        const s = zecMoveStatus(m, ops.data);
        return (
          <PendingLine
            key={m.id}
            tone={s.failed ? 'danger' : 'gold'}
            icon='i-zafu-enso'
            title={`${zatToZec(BigInt(m.zat))} zec · ${m.way === 'deposit' ? 'deposit' : 'withdrawal'}`}
            status={ops.isError ? 'unit did not answer just now' : s.line}
            action={
              s.failed
                ? { label: 'let it go', onClick: () => void zecMoves.forget(m.id) }
                : { label: 'refresh', onClick: () => void ops.refetch() }
            }
          />
        );
      })}
    </>
  );
};
