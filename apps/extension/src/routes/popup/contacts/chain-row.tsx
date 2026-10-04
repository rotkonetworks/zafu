/**
 * The address being added to a contact and the chain it is on: read from the
 * address, or picked (an 0x address can be on base as well as ethereum, and
 * 64 hex is a near account only once near is picked; otherwise it is a zid).
 */

import { useState } from 'react';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { chainLabel, inferChain, refusalOf, type AddressChain } from '../../../addresses/kind';
import { PickSheet } from '../send/send-fields';

const CHAINS: readonly AddressChain[] = [
  'zcash',
  'penumbra',
  'bitcoin',
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'avalanche',
  'bsc',
  'solana',
  'near',
  'cosmos',
];

export const useAddressDraft = () => {
  const [address, setAddress] = useState('');
  const [picked, setPicked] = useState<AddressChain>();
  const s = address.trim();
  return {
    address,
    setAddress,
    chain: picked ?? inferChain(s),
    pick: setPicked,
    refused: s ? refusalOf(s, picked) : undefined,
  };
};

/** one row naming the chain; tapping it lifts the chain list over the sheet */
export const ChainRow = ({
  chain,
  onPick,
}: {
  chain?: AddressChain;
  onPick: (c: AddressChain) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <RowGroup>
        <Row
          type='value'
          label='chain'
          value={chain ? chainLabel(chain) : 'choose'}
          onPress={() => setOpen(true)}
        />
      </RowGroup>
      <PickSheet
        title='which chain'
        open={open}
        onOpenChange={setOpen}
        picks={CHAINS.map(c => ({ key: c, label: chainLabel(c) }))}
        onPick={onPick}
      />
    </>
  );
};
