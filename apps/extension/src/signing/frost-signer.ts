/**
 * The self-custody FROST rounds as an `ExternalSigner` (see external-signer.ts).
 *
 * zafu holds the encrypted FROST share locally; it runs both signing rounds
 * itself, relays to the co-signers, aggregates, and hands the orchard spend-auth
 * signatures back. That is exactly the SYNCHRONOUS-AWAIT topology: the whole
 * request->response happens inside the returned Promise, so it drops straight
 * into `signAndBroadcast`.
 *
 * Post-NU6.3 self-custody FROST is orchard-only: the build fails closed on
 * ironwood (frost=true), the rounds sign orchard alphas, and the only inject
 * role is orchard. So the `spendAuthSigs` variant is the only correct result -
 * never `signedPczt`.
 */

import type { ExternalSigner } from './external-signer';
import {
  runMnemonicFrostSign,
  type MnemonicFrostMultisig,
  type MnemonicFrostSecrets,
} from '../routes/popup/send/frost-multisig';
import type { SendTxPcztUnsignedResult } from '../state/keyring/network-worker';

/** Everything the FROST rounds need that the returned signer closes over: the
 *  multisig group + local secrets, the unsigned build the rounds sign, the
 *  spend metadata co-signers see, and the UI callbacks that drive the room /
 *  progress / abort state in the send component. */
export interface FrostSelfCustodyCtx {
  readonly ms: MnemonicFrostMultisig;
  readonly secrets: MnemonicFrostSecrets;
  readonly unsigned: SendTxPcztUnsignedResult;
  readonly recipient: string;
  readonly amountZat: string;
  readonly setFrostAbort: (a: AbortController) => void;
  readonly setRoomCode: (code: string) => void;
  readonly setProgress: (msg: string) => void;
}

/**
 * Build a self-custody FROST `ExternalSigner`. The returned closure runs the
 * 2-round FROST protocol and returns the aggregated orchard spend-auth
 * signatures for the host to INJECT via `complete_orchard_pczt` (the
 * `spendAuthSigs` variant). The `spendIndices` are the real-spend action indices
 * from the build, aligned 1:1 with the aggregated sigs.
 */
export function frostSelfCustodySigner(ctx: FrostSelfCustodyCtx): ExternalSigner {
  return async () => {
    const spendAuthSigs = await runMnemonicFrostSign({
      ms: ctx.ms,
      secrets: ctx.secrets,
      unsigned: ctx.unsigned,
      recipient: ctx.recipient,
      amountZat: ctx.amountZat,
      setFrostAbort: ctx.setFrostAbort,
      setRoomCode: ctx.setRoomCode,
      setProgress: ctx.setProgress,
    });
    return {
      kind: 'spendAuthSigs',
      spendAuthSigs,
      spendIndices: ctx.unsigned.spendIndices,
    };
  };
}
