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
  /** source account index */
  sourceIndex: number;
  /** loading state */
  loading: boolean;
  /** error message */
  error: string | undefined;

  setChain: (chain: IbcChain | undefined) => void;
  setDestinationAddress: (address: string) => void;
  setAmount: (amount: string) => void;
  setDenom: (denom: string) => void;
  setSourceIndex: (index: number) => void;
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
  sourceIndex: 0,
  loading: false,
  error: undefined as string | undefined,
};

export const createIbcWithdrawSlice: SliceCreator<IbcWithdrawSlice> = (set, get) => ({
  ...initialState,

  setChain: (chain) => set(state => { state.ibcWithdraw.chain = chain; }),
  setDestinationAddress: (address) => set(state => { state.ibcWithdraw.destinationAddress = address; }),
  setAmount: (amount) => set(state => { state.ibcWithdraw.amount = amount; }),
  setDenom: (denom) => set(state => { state.ibcWithdraw.denom = denom; }),
  setSourceIndex: (index) => set(state => { state.ibcWithdraw.sourceIndex = index; }),

  reset: () => set(state => {
    state.ibcWithdraw.chain = initialState.chain;
    state.ibcWithdraw.destinationAddress = initialState.destinationAddress;
    state.ibcWithdraw.amount = initialState.amount;
    state.ibcWithdraw.denom = initialState.denom;
    state.ibcWithdraw.sourceIndex = initialState.sourceIndex;
    state.ibcWithdraw.loading = initialState.loading;
    state.ibcWithdraw.error = initialState.error;
  }),

  buildPlanRequest: async () => {
    const { chain, destinationAddress, amount, denom, sourceIndex } = get().ibcWithdraw;

    if (!chain) throw new Error('no chain selected');
    if (!destinationAddress) throw new Error('no destination address');
    if (!amount || amount === '0') throw new Error('no amount specified');
    if (!denom) throw new Error('no denom specified');

    set(state => { state.ibcWithdraw.loading = true; state.ibcWithdraw.error = undefined; });

    try {
      // parse amount (assuming 6 decimals for now - should come from asset metadata)
      const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1_000_000));

      const timeoutTime = calculateTimeout(Date.now());

      // TODO: get actual timeout height from IBC channel client state
      // for now use a reasonable default
      const timeoutHeight = new Height({
        revisionHeight: 1_000_000n,
        revisionNumber: 1n,
      });

      const addressIndex = new AddressIndex({ account: sourceIndex });

      // TODO: get ephemeral return address from view service
      // for now, this will be filled in by the transaction planner

      const planRequest = new TransactionPlannerRequest({
        ics20Withdrawals: [{
          amount: new Amount({ lo: amountBigInt, hi: 0n }),
          denom: { denom },
          destinationChainAddress: destinationAddress,
          timeoutHeight,
          timeoutTime,
          sourceChannel: chain.channelId,
          // returnAddress will be set by the planner
        }],
        source: addressIndex,
      });

      set(state => { state.ibcWithdraw.loading = false; });
      return planRequest;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown error';
      set(state => { state.ibcWithdraw.loading = false; state.ibcWithdraw.error = error; });
      throw err;
    }
  },
});

/** selectors */
export const selectIbcWithdraw = (state: AllSlices) => state.ibcWithdraw;
export const selectIbcChain = (state: AllSlices) => state.ibcWithdraw.chain;
export const selectIbcDestination = (state: AllSlices) => state.ibcWithdraw.destinationAddress;
export const selectIbcAmount = (state: AllSlices) => state.ibcWithdraw.amount;
