/**
 * listen for identity sign requests from web origins ("login with zafu").
 *
 * flow:
 * 1. dApp sends { type: 'zafu_sign', challengeHex, statement? } via chrome.runtime.sendMessage
 * 2. validate the challenge (hex, even length, 1-1024 bytes)
 * 3. open the SignRequest popup for explicit per-request user confirmation
 *    (the popup shows the calling origin + the challenge / statement)
 * 4. on approval the popup signs with the SITE-SCOPED ZID ed25519 key and
 *    returns { signature, publicKey }; sign_identity is auto-granted afterwards
 *    so the site shows up on the identity page
 *
 * Gate: requests must come from a valid top-level page (isValidExternalSender
 * rejects sub-frames and malformed senders), but there is NO connect-first
 * requirement - any such origin may prompt, and the user's per-request approval
 * in the popup IS the consent. This is safe because the signing key is derived
 * PER ORIGIN: a signature obtained by one site is under that site's ZID key and
 * cannot be replayed at another, so an unapproved origin can at most prompt the
 * user, never obtain a cross-site-usable signature. Relying parties must still
 * bind their origin + a fresh nonce into the challenge (SIWE-style) - the wallet
 * signs exactly the challenge bytes it is given.
 */

import { getOriginPermissions, grantCapability } from '@repo/storage-chrome/origin';
import { hasCapability } from '@repo/storage-chrome/capabilities';
import { UserChoice } from '@repo/storage-chrome/records';
import { PopupType } from '../popup';
import { popup } from '../../popup';
import { isValidExternalSender } from '../../senders/external';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { EncryptedVault } from '../../state/keyring/types';
import type { ZidShareRecord } from '../../state/identity';
import type { ZafuSignRequest, ZafuSignResponse } from '@zafu/protocol';
import { SIGN_REQUEST_TYPE } from './zafu-method-names';

// request/response shapes come from the shared @zafu/protocol contract, so any
// drift from the wallet<->dapp wire (and from the @zafu/zid SDK that builds
// these messages) is a compile error. SignResponse is re-exported under its
// historical name for the popups that import it from here.
type SignRequestMessage = ZafuSignRequest;
export type SignResponse = ZafuSignResponse;

const isSignRequest = (req: unknown): req is SignRequestMessage =>
  typeof req === 'object' &&
  req !== null &&
  'type' in req &&
  (req as { type: unknown }).type === SIGN_REQUEST_TYPE &&
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
  // validate challenge up front: 1-1024 bytes, hex, even length. Rejecting
  // malformed input here (invalid_request) avoids showing the user a sign popup
  // for a challenge that would only fail post-crypto with a generic error.
  if (
    !req.challengeHex ||
    req.challengeHex.length < 2 ||
    req.challengeHex.length > 2048 ||
    req.challengeHex.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(req.challengeHex)
  ) {
    return {
      success: false,
      error: 'invalid challenge: must be 1-1024 bytes hex-encoded',
      code: 'invalid_request',
    };
  }

  try {
    // detect wallet type for mnemonic vs zigner signing flow
    const vaults = ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
    const selectedId = await localExtStorage.get('selectedVaultId');
    const selectedVault = vaults.find(v => v.id === selectedId);
    const isAirgap = selectedVault?.type === 'zigner-zafu';
    const zidPubkey = isAirgap
      ? (selectedVault?.insensitive?.['zid'] as string | undefined)
      : undefined;

    const popupResponse = await popup(PopupType.SignRequest, {
      origin: sender.origin,
      favIconUrl: sender.tab?.favIconUrl,
      title: sender.tab?.title,
      challengeHex: req.challengeHex,
      statement: req.statement,
      isAirgap,
      zidPubkey,
    });

    if (popupResponse?.choice !== UserChoice.Approved) {
      return { success: false, error: 'user denied', code: 'denied' };
    }

    const { signature, publicKey } = popupResponse;

    // auto-grant sign_identity capability so the site appears in the identity page
    const perms = await getOriginPermissions(sender.origin);
    if (!hasCapability(perms, 'sign_identity')) {
      await grantCapability(sender.origin, 'sign_identity');
    }

    // log the shared zid (done in service worker so it persists even if popup closes)
    if (publicKey) {
      const log = ((await localExtStorage.get('zidShareLog')) ?? []) as ZidShareRecord[];
      const alreadyLogged = log.some(
        r => r.publicKey === publicKey && r.sharedWith === sender.origin,
      );
      if (!alreadyLogged) {
        log.push({
          publicKey,
          sharedWith: sender.origin,
          sharedAt: Date.now(),
          identity: 'default',
        });
        await localExtStorage.set('zidShareLog', log);
      }
    }

    return {
      success: true,
      signature,
      publicKey,
    };
  } catch (e) {
    console.error('sign request failed:', e);
    return { success: false, error: 'signing failed', code: 'internal_error' };
  }
};
