/**
 * Penumbra native send state
 *
 * handles building native penumbra transfer transactions
 * (spend -> output, not IBC)
 */

import { AllSlices, SliceCreator } from '.';
import {
  TransactionPlannerRequest,
  type BalancesResponse,
} from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Address } from '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb';
import { Value } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { MemoPlaintext } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import { FeeTier_Tier } from '@penumbra-zone/protobuf/penumbra/core/component/fee/v1/fee_pb';
import {
  getAssetIdFromValueView,
  getDisplayDenomExponentFromValueView,
} from '@penumbra-zone/getters/value-view';
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
  /**
   * True when the user clicked Max and has not edited the amount since.
   * Triggers the spend-all planner path in buildPlanRequest (dry-run for
   * autoFee, then reissue with manualFee) so no change note is created and
   * no dust is left behind. Cleared automatically by setAmount().
   */
  maxMode: boolean;

  setRecipient: (address: string) => void;
  setAmount: (amount: string) => void;
  setMemo: (memo: string) => void;
  /** Called by the Max button. Clears itself on any subsequent setAmount. */
  setMaxMode: (v: boolean) => void;
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
  maxMode: false,
};

export const createPenumbraSendSlice: SliceCreator<PenumbraSendSlice> = (set, get) => ({
  ...initialState,

  setRecipient: address =>
    set(state => {
      state.penumbraSend.recipient = address;
    }),
  setAmount: amount =>
    set(state => {
      state.penumbraSend.amount = amount;
      // Any keystroke in the amount field cancels max-mode. Only the Max
      // button (via setMaxMode(true)) sets it back on.
      state.penumbraSend.maxMode = false;
    }),
  setMemo: memo =>
    set(state => {
      state.penumbraSend.memo = memo;
    }),
  setMaxMode: v =>
    set(state => {
      state.penumbraSend.maxMode = v;
    }),

  reset: () =>
    set(state => {
      state.penumbraSend.recipient = initialState.recipient;
      state.penumbraSend.amount = initialState.amount;
      state.penumbraSend.memo = initialState.memo;
      state.penumbraSend.loading = initialState.loading;
      state.penumbraSend.error = initialState.error;
      state.penumbraSend.maxMode = initialState.maxMode;
    }),

  buildPlanRequest: async (selectedAsset: BalancesResponse) => {
    const { recipient, amount, memo, maxMode } = get().penumbraSend;
    const account = get().keyRing.penumbraAccount;

    if (!recipient) {
      throw new Error('no recipient address');
    }
    if (!amount || amount === '0') {
      throw new Error('no amount specified');
    }
    if (!selectedAsset) {
      throw new Error('no asset selected');
    }

    // validate penumbra address format
    if (!recipient.startsWith('penumbra1')) {
      throw new Error('invalid penumbra address (must start with penumbra1)');
    }

    set(state => {
      state.penumbraSend.loading = true;
      state.penumbraSend.error = undefined;
    });

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

      const memoPlaintext = memo
        ? new MemoPlaintext({
            returnAddress: addressResponse.address,
            text: memo,
          })
        : undefined;

      // Spend-all path: user clicked Max and hasn't edited amount since.
      // Dry-run to learn autoFee, then reissue with manualFee so the
      // output = balance - fee. No change note, no dust left behind.
      // If the fee asset is not the send asset (e.g. sending USDC.inj
      // paying fee in UM), the fee comes out of a separate balance and
      // the output takes the whole selected balance.
      if (maxMode) {
        const totalBig = (baseAmount.hi << 64n) + baseAmount.lo;
        // 0.001 display-unit headroom for the dry-run so autoFee has
        // room to plan; ~2x the typical single-spend fee, plenty.
        const HEADROOM_DISPLAY = 0.001;
        const headroomBase = BigInt(Math.floor(HEADROOM_DISPLAY * multiplier));
        const dryBig = totalBig > headroomBase ? totalBig - headroomBase : 0n;
        if (dryBig <= 0n) {
          throw new Error('balance is too small for a spend-all send');
        }
        const dryAmount = new Amount({
          lo: dryBig & ((1n << 64n) - 1n),
          hi: dryBig >> 64n,
        });
        const dryReq = new TransactionPlannerRequest({
          source: { account },
          outputs: [
            {
              address: new Address({ altBech32m: recipient }),
              value: new Value({ amount: dryAmount, assetId }),
            },
          ],
          memo: memoPlaintext,
          feeMode: { case: 'autoFee', value: { feeTier: FeeTier_Tier.LOW } },
        });
        const { plan } = await viewClient.transactionPlanner(dryReq);
        const fee = plan?.transactionParameters?.fee;
        const feeAmount = fee?.amount;
        if (!fee || !feeAmount) {
          throw new Error('planner did not return a fee for the spend-all dry run');
        }

        // Same-asset fee? Compare inner byte arrays; the fee asset id
        // may be undefined which conventionally means the staking token (UM).
        const feeAssetId = fee.assetId;
        const feeIsSameAsset =
          !feeAssetId ||
          (!!assetId &&
            feeAssetId.inner.length === assetId.inner.length &&
            feeAssetId.inner.every((b, i) => b === assetId.inner[i]));

        const feeBig = (feeAmount.hi << 64n) + feeAmount.lo;
        const outBig = feeIsSameAsset ? totalBig - feeBig : totalBig;
        if (outBig <= 0n) {
          throw new Error('balance too small to cover the transaction fee');
        }
        const outAmount = new Amount({
          lo: outBig & ((1n << 64n) - 1n),
          hi: outBig >> 64n,
        });

        const realReq = new TransactionPlannerRequest({
          source: { account },
          outputs: [
            {
              address: new Address({ altBech32m: recipient }),
              value: new Value({ amount: outAmount, assetId }),
            },
          ],
          memo: memoPlaintext,
          feeMode: { case: 'manualFee', value: fee },
        });
        set(state => {
          state.penumbraSend.loading = false;
        });
        return realReq;
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
        memo: memoPlaintext,
        feeMode: {
          case: 'autoFee',
          value: { feeTier: FeeTier_Tier.LOW },
        },
      });

      set(state => {
        state.penumbraSend.loading = false;
      });
      return planRequest;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown error';
      set(state => {
        state.penumbraSend.loading = false;
        state.penumbraSend.error = error;
      });
      throw err;
    }
  },
});

/** selectors */
export const selectPenumbraSend = (state: AllSlices) => state.penumbraSend;
export const selectPenumbraRecipient = (state: AllSlices) => state.penumbraSend.recipient;
export const selectPenumbraAmount = (state: AllSlices) => state.penumbraSend.amount;
