/**
 * Penumbra native send state
 *
 * handles building native penumbra transfer transactions
 * (spend -> output, not IBC)
 */

import { AllSlices, SliceCreator } from '.';
import { TransactionPlannerRequest, type BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Address } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { Value } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { MemoPlaintext } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { FeeTier_Tier } from '@penumbra-zone/protobuf/penumbra/core/component/fee/v1/fee_pb';
import { getAssetIdFromValueView, getDisplayDenomExponentFromValueView } from '@penumbra-zone/getters/value-view';
import { viewClient } from '../clients';

export interface PenumbraSendSlice {
  /** recipient penumbra address (penumbra1...) */
  recipient: string;
  /** amount to send (display units) */
  amount: string;
  /** optional memo */
  memo: string;
  /** loading state */
  loading: boolean;
  /** error message */
  error: string | undefined;

  setRecipient: (address: string) => void;
  setAmount: (amount: string) => void;
  setMemo: (memo: string) => void;
  reset: () => void;

  /** build the transaction planner request - selectedAsset passed as param */
  buildPlanRequest: (selectedAsset: BalancesResponse) => Promise<TransactionPlannerRequest>;
}

const initialState = {
  recipient: '',
  amount: '',
  memo: '',
  loading: false,
  error: undefined as string | undefined,
};

export const createPenumbraSendSlice: SliceCreator<PenumbraSendSlice> = (set, get) => ({
  ...initialState,

  setRecipient: (address) => set(state => { state.penumbraSend.recipient = address; }),
  setAmount: (amount) => set(state => { state.penumbraSend.amount = amount; }),
  setMemo: (memo) => set(state => { state.penumbraSend.memo = memo; }),

  reset: () => set(state => {
    state.penumbraSend.recipient = initialState.recipient;
    state.penumbraSend.amount = initialState.amount;
    state.penumbraSend.memo = initialState.memo;
    state.penumbraSend.loading = initialState.loading;
    state.penumbraSend.error = initialState.error;
  }),

  buildPlanRequest: async (selectedAsset: BalancesResponse) => {
    const { recipient, amount, memo } = get().penumbraSend;
    const account = get().keyRing.penumbraAccount;

    if (!recipient) throw new Error('no recipient address');
    if (!amount || amount === '0') throw new Error('no amount specified');
    if (!selectedAsset) throw new Error('no asset selected');

    // validate penumbra address format
    if (!recipient.startsWith('penumbra1')) {
      throw new Error('invalid penumbra address (must start with penumbra1)');
    }

    set(state => { state.penumbraSend.loading = true; state.penumbraSend.error = undefined; });

    try {
      // get asset id and exponent from selected balance
      const assetId = getAssetIdFromValueView(selectedAsset.balanceView);
      const exponent = getDisplayDenomExponentFromValueView(selectedAsset.balanceView);

      // convert display amount to base units using exponent
      const multiplier = 10 ** exponent;
      const baseAmount = new Amount({
        lo: BigInt(Math.floor(parseFloat(amount) * multiplier)),
        hi: 0n,
      });

      // get return address for memo
      const addressResponse = await viewClient.addressByIndex({ addressIndex: { account } });
      if (!addressResponse.address) {
        throw new Error('failed to get return address');
      }

      const planRequest = new TransactionPlannerRequest({
        source: { account },
        outputs: [
          {
            address: new Address({ altBech32m: recipient }),
            value: new Value({
              amount: baseAmount,
              assetId,
            }),
          },
        ],
        memo: memo ? new MemoPlaintext({
          returnAddress: addressResponse.address,
          text: memo,
        }) : undefined,
        feeMode: {
          case: 'autoFee',
          value: { feeTier: FeeTier_Tier.LOW },
        },
      });

      set(state => { state.penumbraSend.loading = false; });
      return planRequest;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown error';
      set(state => { state.penumbraSend.loading = false; state.penumbraSend.error = error; });
      throw err;
    }
  },
});

/** selectors */
export const selectPenumbraSend = (state: AllSlices) => state.penumbraSend;
export const selectPenumbraRecipient = (state: AllSlices) => state.penumbraSend.recipient;
export const selectPenumbraAmount = (state: AllSlices) => state.penumbraSend.amount;
