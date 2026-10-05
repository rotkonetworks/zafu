/**
 * The co-signer's review of a signing request, as one function: the route
 * (multisig/sign.tsx) and a payment card in a chat both call it. Truth comes
 * from the PCZT (the worker recomputes the sighash and decrypts the outputs
 * with the shared viewing key); anything that cannot be verified refuses.
 * There is no "show it anyway" path, because the requester chooses whether
 * we can verify.
 */

import {
  frostInspectPcztOutputsInWorker,
  type FrostParsedTx,
} from '../../../../state/keyring/network-worker';
import { assessClaimedFee, computeVerdict, type Verdict } from './multisig-verifier';

export interface SignRequestClaim {
  sighash: string;
  recipient: string;
  amountZat: string;
  feeZat: string;
  pcztHex?: string;
}

const refuse = (...reasons: string[]): { verdict: Verdict } => ({
  verdict: { kind: 'refuse', reasons },
});

export const reviewSignRequest = async (
  req: SignRequestClaim,
  /** the shared wallet's `uview1…` viewing key */
  ufvk: string | undefined,
  mainnet: boolean,
  inspect = frostInspectPcztOutputsInWorker,
): Promise<{ verdict: Verdict; parsed?: FrostParsedTx }> => {
  const fee = assessClaimedFee(req.feeZat, req.amountZat);
  if (!req.pcztHex) {
    return refuse(
      'host did not publish the PCZT bytes - everything shown here would be host-authored text bound to nothing',
      "zafu keeps your share back · this request can't be checked",
    );
  }
  if (!ufvk) {
    return refuse(
      'this wallet has no viewing key on file, so the PCZT cannot be decoded',
      "zafu keeps your share back · this request can't be checked",
    );
  }
  if (!fee.ok) {
    return refuse(fee.reason);
  }
  try {
    const parsed = await inspect(req.pcztHex, ufvk);
    return {
      parsed,
      verdict: computeVerdict({
        parsed,
        claimedRecipient: req.recipient,
        claimedAmountZat: req.amountZat,
        claimedSighashHex: req.sighash,
        mainnet,
      }),
    };
  } catch (err) {
    return refuse(
      `could not parse the published PCZT: ${err instanceof Error ? err.message : 'parse failed'}`,
      "zafu keeps your share back · this request can't be checked",
    );
  }
};
