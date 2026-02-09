import { Ics20Withdrawal } from '@penumbra-zone/protobuf/penumbra/core/component/ibc/v1/ibc_pb';
import { ViewBox } from '../viewbox';
import { ActionDetails } from './action-details';
import { joinLoHiAmount } from '@rotko/penumbra-types/amount';
import { getTransmissionKeyByAddress } from '@rotko/penumbra-wasm/keys';
import { bech32TransparentAddress } from '@penumbra-zone/bech32m/tpenumbra';
import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';
import { Address } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { useEffect, useState } from 'react';

const getUtcTime = (time: bigint) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'long',
    timeZone: 'UTC',
  });
  const date = new Date(Number(time / 1_000_000n));
  return formatter.format(date);
};

const ReturnAddressDisplay = ({
  returnAddress,
  useTransparentAddress,
}: {
  returnAddress: Address;
  useTransparentAddress: boolean;
}) => {
  const [displayAddress, setDisplayAddress] = useState<string>('...');

  useEffect(() => {
    if (useTransparentAddress) {
      getTransmissionKeyByAddress(returnAddress).then(inner => {
        setDisplayAddress(bech32TransparentAddress({ inner }));
      });
    } else {
      setDisplayAddress(bech32mAddress(returnAddress));
    }
  }, [returnAddress, useTransparentAddress]);

  return <span className='truncate max-w-[125px]'>{displayAddress}</span>;
};

export const Ics20WithdrawalComponent = ({ value }: { value: Ics20Withdrawal }) => {
  return (
    <ViewBox
      label='Ics20 Withdrawal'
      visibleContent={
        <ActionDetails>
          {value.denom && <ActionDetails.Row label='Denom'>{value.denom.denom}</ActionDetails.Row>}

          {value.amount && (
            <ActionDetails.Row label='Amount'>
              {joinLoHiAmount(value.amount).toString()}
            </ActionDetails.Row>
          )}

          <ActionDetails.Row label='Destination Address'>
            <span className='truncate max-w-[125px]'>{value.destinationChainAddress}</span>
          </ActionDetails.Row>

          <ActionDetails.Row label='Source channel'>{value.sourceChannel}</ActionDetails.Row>

          {value.returnAddress && (
            <ActionDetails.Row label='Return Address'>
              <ReturnAddressDisplay
                returnAddress={value.returnAddress}
                useTransparentAddress={value.useTransparentAddress}
              />
            </ActionDetails.Row>
          )}

          {value.timeoutHeight && (
            <>
              <ActionDetails.Row label='Timeout Revision Height'>
                {value.timeoutHeight.revisionHeight.toString()}
              </ActionDetails.Row>
              <ActionDetails.Row label='Timeout Revision Number'>
                {value.timeoutHeight.revisionNumber.toString()}
              </ActionDetails.Row>
            </>
          )}

          <ActionDetails.Row label='Timeout Time'>
            {getUtcTime(value.timeoutTime)}
          </ActionDetails.Row>
        </ActionDetails>
      }
    />
  );
};
