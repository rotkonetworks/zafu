/**
 * Pick one of the account's penumbra balances: the assets, and, where the
 * screen allows them, the lp positions behind a switch. Send, withdraw and
 * swap all choose from here.
 */

import { useState } from 'react';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { symbolFromMetadata } from '../../../utils/asset-display';
import { positionLabel } from '../../../utils/is-fungible-asset';
import { AssetBucketToggle, type AssetBucket } from '../../../components/asset-bucket-toggle';
import { PickSheet } from './send-fields';

/** what the form shows for a balance: its symbol and display amount */
export const balanceLook = (b: BalancesResponse | undefined) => {
  const meta = getMetadataFromBalancesResponse.optional(b);
  const amt = b?.balanceView ? fromValueView(b.balanceView) : '0';
  return {
    meta,
    symbol: b ? (positionLabel(meta) ?? symbolFromMetadata(meta)) : 'asset',
    amount: typeof amt === 'string' ? amt : amt.toString(),
  };
};

export function BalanceSheet({
  open,
  onOpenChange,
  assets,
  positions,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assets: readonly BalancesResponse[];
  /** omitted where a position can't be used */
  positions?: readonly BalancesResponse[];
  onPick: (b: BalancesResponse, isPosition: boolean) => void;
}) {
  const [bucket, setBucket] = useState<AssetBucket>('assets');
  const list = bucket === 'positions' && positions ? positions : assets;
  return (
    <PickSheet
      title='asset'
      open={open}
      onOpenChange={next => {
        onOpenChange(next);
        // it always reopens on the fungible list
        setBucket('assets');
      }}
      head={
        positions && (
          <AssetBucketToggle
            bucket={bucket}
            onChange={setBucket}
            positionCount={positions.length}
          />
        )
      }
      picks={list.map((b, i) => {
        const { symbol, amount } = balanceLook(b);
        return { key: i, label: symbol, value: amount };
      })}
      onPick={i => onPick(list[i]!, list === positions)}
      empty={bucket === 'positions' ? 'no open positions' : 'no assets yet'}
    />
  );
}
