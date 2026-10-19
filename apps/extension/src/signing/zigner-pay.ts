/**
 * A plain zcash payment from a zigner wallet, outside the send screen: build
 * the PCZT the send screen builds, one device round, broadcast. Subscribe and
 * a crosschain deposit pay this way.
 *
 * It replaces the legacy `530402` sign request (a bare sighash plus
 * randomizers and a free-text summary), which made zigner sign a digest it
 * could not check against anything it showed. Here zigner recomputes the
 * sighash from the PCZT and shows the recipient, amount and fee it proves.
 */

import {
  applySignatureContributionsInWorker,
  buildSendTxPcztInWorker,
  completeSendTxPcztInWorker,
  type SignatureContribution,
} from '../state/keyring/network-worker';
import { createZignerRound, type ZignerRound } from './zigner-round';

/** a round whose compact answers merge through `walletId`'s worker */
export const zignerRound = (walletId: () => string): ZignerRound =>
  createZignerRound((pczt, json) =>
    applySignatureContributionsInWorker(
      'zcash',
      walletId(),
      pczt,
      JSON.parse(json) as SignatureContribution[],
    ),
  );

export interface ZignerPayment {
  walletId: string;
  serverUrl: string;
  recipient: string;
  amountZat: string;
  memo: string;
  mainnet: boolean;
  ufvk: string;
}

/**
 * Pay `p` through `round`, named `label` on screen. Resolves with the txid
 * once broadcast; rejects with `ZignerDeclined` if the person steps back.
 * `onSigned` runs (and is awaited) between the device's answer and the
 * broadcast: the place to record what is about to go out.
 */
export const payViaZigner = async (
  round: ZignerRound,
  p: ZignerPayment,
  label: string,
  onSigned: () => void | Promise<void>,
): Promise<string> => {
  const built = await buildSendTxPcztInWorker(
    'zcash',
    p.walletId,
    p.serverUrl,
    p.recipient,
    p.amountZat,
    p.memo,
    // the worker anchors to the live tip it fetches; 0 means no hint
    0,
    p.mainnet,
    p.ufvk,
    false,
    undefined,
    undefined,
    true,
  );
  const signed = await round.sign(built, label);
  await onSigned();
  const { txid } = await completeSendTxPcztInWorker(
    'zcash',
    p.walletId,
    p.serverUrl,
    signed,
    built.coldSendId,
  );
  return txid;
};
