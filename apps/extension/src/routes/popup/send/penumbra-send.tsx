/** penumbra send (penumbra -> penumbra), on the shared send steps */

import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { useStore } from '../../../state';
import { selectPenumbraAccount } from '../../../state/keyring';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { selectPenumbraSend } from '../../../state/penumbra-send';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { isPositionBalance, selectPickerBuckets } from '../../../utils/is-fungible-asset';
import { balancesQueryOptions } from '../../../hooks/penumbra-balances';
import { ScreenHeader } from '../../../components/screen-header';
import { Sensitive } from '../../../components/sensitive';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { EMPTY_BALANCES } from './shared';
import { Footer, Main, shortAddress } from './send-ui';
import { AmountField, AddressSheet, ToField } from './send-fields';
import { BalanceSheet, balanceLook } from './balance-sheet';
import { PenumbraFlow } from './penumbra-flow';

export function PenumbraSend({
  onClose,
  prefillAsset,
  prefillRecipient,
  prefillMemo,
  meta,
}: {
  onClose: () => void;
  /** base denom the row-level "send X" action preselects */
  prefillAsset?: string;
  /** a contact's address, from the contact's "send" */
  prefillRecipient?: string;
  /** a message from a thread's composer */
  prefillMemo?: string;
  /** the header's mode switch */
  meta?: ReactNode;
}) {
  const navigate = usePopupNav();
  const sendState = useStore(selectPenumbraSend);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const { recordUsage, shouldSuggestSave } = useStore(recentAddressesSelector);
  const { findByAddress } = useStore(contactsSelector);
  const [assetOpen, setAssetOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [sent, setSent] = useState<{ to: string; amount: string; unit: string; memo: string }>();

  const { setRecipient, setMemo } = sendState;
  useEffect(() => {
    if (prefillRecipient) {
      setRecipient(prefillRecipient);
    }
    if (prefillMemo) {
      setMemo(prefillMemo);
    }
  }, [prefillRecipient, prefillMemo, setRecipient, setMemo]);

  // the ['balances', account] cache holds the raw list (home preloads it);
  // `select` buckets it per observer
  const { data: buckets } = useQuery({
    ...balancesQueryOptions(penumbraAccount),
    staleTime: 30_000,
    select: selectPickerBuckets,
  });
  const balances = buckets?.assets ?? EMPTY_BALANCES;
  const positions = buckets?.positions ?? EMPTY_BALANCES;

  // not in zustand: immer and protobuf messages don't mix
  const [picked, setPicked] = useState<BalancesResponse>();
  const asset =
    picked ??
    (prefillAsset
      ? balances.find(b => getMetadataFromBalancesResponse.optional(b)?.base === prefillAsset)
      : undefined) ??
    balances[0];
  const { symbol, amount: available } = balanceLook(asset);
  const unit = symbol.toLowerCase();

  const to = sendState.recipient.trim();
  const addressValid = !to || to.startsWith('penumbra1');
  const toName = to ? findByAddress(to)?.contact.name : undefined;
  const canReview = !!asset && addressValid && !!to && parseFloat(sendState.amount) > 0;
  const sending = (
    <>
      send <Sensitive>{`${sendState.amount} ${unit}`}</Sensitive> to {toName ?? shortAddress(to)}
    </>
  );

  return (
    <PenumbraFlow
      onClose={onClose}
      tx={{
        sending,
        label: `send ${sendState.amount} ${symbol}`,
        plan: () => sendState.buildPlanRequest(asset!),
        onSent: () => {
          void recordUsage(to, 'penumbra');
          setSent({ to, amount: sendState.amount, unit, memo: sendState.memo });
          sendState.reset();
        },
        review: {
          amount: sendState.amount,
          unit,
          rows: [
            ['to', toName ? `${toName} · ${shortAddress(to)}` : shortAddress(to)],
            ['fee', 'shown before you approve'],
          ],
          privacy: 'shielded · amount and memo stay private',
          confirm: 'sign & send',
        },
        done: sending,
      }}
      doneActions={txId => (
        <>
          {sent && shouldSuggestSave(sent.to) && !findByAddress(sent.to) && (
            <>
              <Button variant='secondary' onClick={() => setSaveOpen(true)} className='px-3'>
                save contact
              </Button>
              {saveOpen && (
                <SaveContactModal
                  address={sent.to}
                  network='penumbra'
                  onDone={() => setSaveOpen(false)}
                  onCancel={() => setSaveOpen(false)}
                />
              )}
            </>
          )}
          <Button
            variant='secondary'
            onClick={() =>
              navigate(PopupPath.TX_DETAIL, {
                state: {
                  network: 'penumbra',
                  tx: {
                    id: txId,
                    height: 0,
                    timestamp: null,
                    sentAt: Date.now(),
                    type: 'send',
                    description: 'sent',
                    amount: sent?.amount,
                    asset: sent?.unit,
                    memo: sent?.memo,
                    recipient: sent?.to,
                    status: 'pending',
                  },
                },
              })
            }
            className='px-3'
          >
            view transaction
          </Button>
        </>
      )}
    >
      {review => (
        <>
          <ScreenHeader title='send' onBack={onClose} meta={meta} />
          <Main className='gap-[18px] pt-5'>
            <ToField
              value={sendState.recipient}
              onChange={sendState.setRecipient}
              warn={!addressValid}
              helper={
                !addressValid
                  ? 'that is not a penumbra address · please check it'
                  : toName && `${toName} · shielded`
              }
              onContacts={() => setBookOpen(true)}
              onScan={() => setScanOpen(true)}
            />
            <AmountField
              value={sendState.amount}
              onChange={sendState.setAmount}
              unit={unit}
              onUnit={() => setAssetOpen(true)}
              available={asset ? available : undefined}
              // spend-all: buildPlanRequest plans balance minus fee, no change
              onMax={() => {
                sendState.setAmount(available);
                sendState.setMaxMode(true);
              }}
              canMax={!!asset}
              autoFocus={!!prefillAsset}
            />
            <div className='flex flex-col gap-1.5'>
              <label htmlFor='send-memo' className='text-xs text-fg-muted'>
                memo
              </label>
              <Input
                id='send-memo'
                placeholder={`optional, only ${toName ?? 'they'} can read it`}
                value={sendState.memo}
                onChange={e => sendState.setMemo(e.target.value)}
              />
            </div>
          </Main>
          <Footer>
            <Button onClick={review} disabled={!canReview} className='w-full'>
              review
            </Button>
          </Footer>
          <BalanceSheet
            open={assetOpen}
            onOpenChange={setAssetOpen}
            assets={balances}
            positions={positions}
            onPick={(b, isPosition) => {
              const wasPosition = !!asset && isPositionBalance(asset);
              setPicked(b);
              // a position is indivisible: send the whole thing, and never
              // carry its "1" over to a fungible asset
              if (isPosition) {
                sendState.setAmount(balanceLook(b).amount);
              } else if (wasPosition) {
                sendState.setAmount('');
              }
            }}
          />
          <AddressSheet
            chain='penumbra'
            open={bookOpen}
            onOpenChange={setBookOpen}
            onScan={() => setScanOpen(true)}
            onPick={row => sendState.setRecipient(row.address)}
          />
          {scanOpen && (
            <QrScanner
              onScan={data => {
                sendState.setRecipient(data);
                setScanOpen(false);
              }}
              onClose={() => setScanOpen(false)}
              title='scan an address'
            />
          )}
        </>
      )}
    </PenumbraFlow>
  );
}
