/**
 * IBC withdrawal state for penumbra -> cosmos transfers
 *
 * handles building ICS20 withdrawal transactions with proper
 * timeout calculation and ephemeral return addresses
 */

import { AllSlices, SliceCreator } from '.';
import type { IbcChain } from '../hooks/ibc-chains';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { AddressIndex } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { Height } from '@penumbra-zone/protobuf/ibc/core/client/v1/client_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { splitLoHi } from '@rotko/penumbra-types/lo-hi';
import { viewClient } from '../clients';
import { toBaseUnits } from './ibc-withdraw-amount';
import { getCounterpartyHeight, timeoutBlocksForChain } from './ibc-withdraw-timeout';

/** two days in milliseconds */
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
/** ten minutes in milliseconds */
const TEN_MINS_MS = 10 * 60 * 1000;

export interface IbcWithdrawSlice {
  /** selected destination chain */
  chain: IbcChain | undefined;
  /** destination address on the chain */
  destinationAddress: string;
  /** amount to send (display units) */
  amount: string;
  /** selected asset denom */
  denom: string;
  /**
   * Decimal exponent of the selected asset's DISPLAY denom (the `denomUnits`
   * entry matching `display` in the registry Metadata): 6 for UM and the
   * stablecoins, 18 for INJ. Set together with `denom`; `undefined` means we
   * have no metadata and must refuse to guess.
   */
  exponent: number | undefined;
  /** loading state */
  loading: boolean;
  /** error message */
  error: string | undefined;

  setChain: (chain: IbcChain | undefined) => void;
  setDestinationAddress: (address: string) => void;
  setAmount: (amount: string) => void;
  setDenom: (denom: string, exponent: number | undefined) => void;
  reset: () => void;

  /** build the transaction planner request */
  buildPlanRequest: () => Promise<TransactionPlannerRequest>;
}

/** calculate privacy-preserving timeout (rounded to 10-min intervals) */
const calculateTimeout = (nowMs: number): bigint => {
  const twoDaysFromNow = nowMs + TWO_DAYS_MS;
  const rounded = twoDaysFromNow + TEN_MINS_MS - (twoDaysFromNow % TEN_MINS_MS);
  // convert to nanoseconds
  return BigInt(rounded) * 1_000_000n;
};

const initialState = {
  chain: undefined as IbcChain | undefined,
  destinationAddress: '',
  amount: '',
  denom: '',
  exponent: undefined as number | undefined,
  loading: false,
  error: undefined as string | undefined,
};

export const createIbcWithdrawSlice: SliceCreator<IbcWithdrawSlice> = (set, get) => ({
  ...initialState,

  setChain: chain =>
    set(state => {
      state.ibcWithdraw.chain = chain;
    }),
  setDestinationAddress: address =>
    set(state => {
      state.ibcWithdraw.destinationAddress = address;
    }),
  setAmount: amount =>
    set(state => {
      state.ibcWithdraw.amount = amount;
    }),
  setDenom: (denom, exponent) =>
    set(state => {
      state.ibcWithdraw.denom = denom;
      state.ibcWithdraw.exponent = exponent;
    }),

  reset: () =>
    set(state => {
      state.ibcWithdraw.chain = initialState.chain;
      state.ibcWithdraw.destinationAddress = initialState.destinationAddress;
      state.ibcWithdraw.amount = initialState.amount;
      state.ibcWithdraw.denom = initialState.denom;
      state.ibcWithdraw.exponent = initialState.exponent;
      state.ibcWithdraw.loading = initialState.loading;
      state.ibcWithdraw.error = initialState.error;
    }),

  buildPlanRequest: async () => {
    const { chain, destinationAddress, amount, denom, exponent } = get().ibcWithdraw;
    const sourceIndex = get().keyRing.penumbraAccount;

    if (!chain) {
      throw new Error('no chain selected');
    }
    if (!destinationAddress) {
      throw new Error('no destination address');
    }
    if (!amount || amount === '0') {
      throw new Error('no amount specified');
    }
    if (!denom) {
      throw new Error('no denom specified');
    }
    // No silent fallback: guessing 6 here is what sent 1e-12 INJ.
    if (exponent === undefined) {
      throw new Error('no asset metadata for selected denom - cannot determine decimals');
    }

    set(state => {
      state.ibcWithdraw.loading = true;
      state.ibcWithdraw.error = undefined;
    });

    try {
      // scale the typed decimal string by the asset's own exponent, as integers
      const amountBigInt = toBaseUnits(amount, exponent);
      if (amountBigInt <= 0n) {
        throw new Error('amount is zero');
      }

      const timeoutTime = calculateTimeout(Date.now());

      // query counterparty chain's latest height and add buffer for timeout
      const counterparty = await getCounterpartyHeight(chain.chainId);
      const timeoutHeight = new Height({
        revisionHeight: counterparty.height + timeoutBlocksForChain(chain.chainId),
        revisionNumber: counterparty.revisionNumber,
      });

      const addressIndex = new AddressIndex({ account: sourceIndex });

      // get ephemeral return address for IBC refunds
      const ephemeralResponse = await viewClient.ephemeralAddress({ addressIndex });
      if (!ephemeralResponse.address) {
        throw new Error('failed to get return address');
      }

      const planRequest = new TransactionPlannerRequest({
        ics20Withdrawals: [
          {
            // 18-decimal assets overflow a u64 above ~18.4 whole units, so the
            // amount has to be split across lo/hi rather than stuffed into lo.
            amount: new Amount(splitLoHi(amountBigInt)),
            denom: { denom },
            destinationChainAddress: destinationAddress,
            returnAddress: ephemeralResponse.address,
            timeoutHeight,
            timeoutTime,
            sourceChannel: chain.channelId,
          },
        ],
        source: addressIndex,
      });

      set(state => {
        state.ibcWithdraw.loading = false;
      });
      return planRequest;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown error';
      set(state => {
        state.ibcWithdraw.loading = false;
        state.ibcWithdraw.error = error;
      });
      throw err;
    }
  },
});

/** selectors */
export const selectIbcWithdraw = (state: AllSlices) => state.ibcWithdraw;
export const selectIbcChain = (state: AllSlices) => state.ibcWithdraw.chain;
export const selectIbcDestination = (state: AllSlices) => state.ibcWithdraw.destinationAddress;
export const selectIbcAmount = (state: AllSlices) => state.ibcWithdraw.amount;
export const selectIbcExponent = (state: AllSlices) => state.ibcWithdraw.exponent;
