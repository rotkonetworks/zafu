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
import { viewClient } from '../clients';

/** two days in milliseconds */
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
/** ten minutes in milliseconds */
const TEN_MINS_MS = 10 * 60 * 1000;

/** REST endpoints for counterparty chains (for querying latest block height) */
const CHAIN_REST_ENDPOINTS: Record<string, string> = {
  'noble-1': 'https://noble-api.polkachu.com',
  'osmosis-1': 'https://lcd.osmosis.zone',
  'nomic-stakenet-3': 'https://app.nomic.io:8443',
  'celestia': 'https://celestia-api.polkachu.com',
};

/** query the latest block height on a counterparty cosmos chain */
const getCounterpartyHeight = async (chainId: string): Promise<{ height: bigint; revisionNumber: bigint }> => {
  const restEndpoint = CHAIN_REST_ENDPOINTS[chainId];
  if (!restEndpoint) {
    throw new Error(`no REST endpoint for chain ${chainId}`);
  }

  const res = await fetch(`${restEndpoint}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  if (!res.ok) throw new Error(`failed to query ${chainId} latest block: ${res.status}`);

  const data = await res.json();
  const latestHeight = BigInt(data.block?.header?.height ?? data.sdk_block?.header?.height ?? '0');
  if (latestHeight === 0n) throw new Error(`could not parse latest height for ${chainId}`);

  // revision number from chain ID (e.g. "noble-1" -> 1, "osmosis-1" -> 1)
  const revMatch = chainId.match(/-(\d+)$/);
  const revisionNumber = revMatch?.[1] ? BigInt(revMatch[1]) : 0n;

  return { height: latestHeight, revisionNumber };
};

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

      // query counterparty chain's latest height and add buffer for timeout
      const counterparty = await getCounterpartyHeight(chain.chainId);
      const timeoutHeight = new Height({
        revisionHeight: counterparty.height + 1000n,
        revisionNumber: counterparty.revisionNumber,
      });

      const addressIndex = new AddressIndex({ account: sourceIndex });

      // get ephemeral return address for IBC refunds
      const ephemeralResponse = await viewClient.ephemeralAddress({ addressIndex });
      if (!ephemeralResponse.address) {
        throw new Error('failed to get return address');
      }

      const planRequest = new TransactionPlannerRequest({
        ics20Withdrawals: [{
          amount: new Amount({ lo: amountBigInt, hi: 0n }),
          denom: { denom },
          destinationChainAddress: destinationAddress,
          returnAddress: ephemeralResponse.address,
          timeoutHeight,
          timeoutTime,
          sourceChannel: chain.channelId,
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
