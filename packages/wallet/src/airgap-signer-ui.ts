import {
  AuthorizationData,
  TransactionPlan,
} from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';

/**
 * Legacy airgap signer authorization stub.
 *
 * The actual airgap signing flow is handled by the extension's popup-based flow
 * (authorization.ts → tx-approval state → transaction/index.tsx) which has access
 * to the FVK needed for correct effect hash computation via WASM.
 */
export async function airgapSignerAuthorize(_plan: TransactionPlan): Promise<AuthorizationData> {
  throw new Error('Legacy airgap signing is not supported. Use the popup-based flow instead.');
}
