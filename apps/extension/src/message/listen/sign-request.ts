/**
 * listen for identity sign requests from approved origins.
 *
 * flow:
 * 1. dApp sends { type: 'zafu_sign', challengeHex, statement? } via chrome.runtime.sendMessage
 * 2. we check if origin is already approved (via knownSites)
 * 3. if not approved, deny immediately (must connect first)
 * 4. if approved, open SignRequest popup for user confirmation
 * 5. popup signs with ed25519 identity key, returns { signature, publicKey }
 *
 * dApps must first be approved via the standard connect flow (OriginApproval).
 * sign requests from unapproved origins are silently denied.
 */

import { getOriginRecord } from '@repo/storage-chrome/origin';
import { UserChoice } from '@repo/storage-chrome/records';
import { PopupType } from '../../message/popup';
import { popup } from '../../popup';
import { isValidExternalSender } from '../../senders/external';

interface SignRequestMessage {
  type: 'zafu_sign';
  challengeHex: string;
  statement?: string;
}

export interface SignResponse {
  success: boolean;
  signature?: string;
  publicKey?: string;
  error?: string;
}

const isSignRequest = (req: unknown): req is SignRequestMessage =>
  typeof req === 'object' &&
  req !== null &&
  'type' in req &&
  (req as { type: unknown }).type === 'zafu_sign' &&
  'challengeHex' in req &&
  typeof (req as { challengeHex: unknown }).challengeHex === 'string';

export const signRequestListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (r: SignResponse) => void,
): boolean => {
  if (!isSignRequest(req)) {
    return false;
  }

  if (!isValidExternalSender(sender)) {
    return false;
  }

  void handleSignRequest(req, sender).then(respond);
  return true;
};

const handleSignRequest = async (
  req: SignRequestMessage,
  sender: { origin: string; tab: chrome.tabs.Tab },
): Promise<SignResponse> => {
  // only sign for already-approved origins
  const record = await getOriginRecord(sender.origin);
  if (record?.choice !== UserChoice.Approved) {
    return { success: false, error: 'origin not approved — call connect() first' };
  }

  // validate challenge
  if (!req.challengeHex || req.challengeHex.length < 2 || req.challengeHex.length > 2048) {
    return { success: false, error: 'invalid challenge: must be 1-1024 bytes hex-encoded' };
  }

  try {
    const popupResponse = await popup(PopupType.SignRequest, {
      origin: sender.origin,
      favIconUrl: sender.tab?.favIconUrl,
      title: sender.tab?.title,
      challengeHex: req.challengeHex,
      statement: req.statement,
    });

    if (!popupResponse || popupResponse.choice !== UserChoice.Approved) {
      return { success: false, error: 'user denied' };
    }

    return {
      success: true,
      signature: popupResponse.signature,
      publicKey: popupResponse.publicKey,
    };
  } catch (e) {
    console.error('sign request failed:', e);
    return { success: false, error: 'signing failed' };
  }
};
