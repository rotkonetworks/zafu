/**
 * external message listener — handles messages from websites via externally_connectable
 *
 * supports:
 * - { type: 'ping' } → responds with { zafu: true, version }
 * - { type: 'send', address } → opens send popup
 * - { type: 'zafu_sign', challengeHex, ... } → sign request (handled elsewhere)
 * - { type: 'zafu_request_capability', capability } → request a specific capability
 * - { type: 'zafu_pick_contacts', purpose, max } → opens contact picker popup
 * - { type: 'zafu_pick_contacts_result', requestId, contacts } → internal: picker result
 * - { type: 'zafu_send_invite', handle, payload } → route invite via e2ee
 * - { type: 'zafu_frost_create' } → create FROST DKG, returns approval popup
 * - { type: 'zafu_frost_join', roomCode } → join existing FROST DKG
 * - { type: 'zafu_frost_sign', roomCode, sighashHex, ... } → FROST signing session
 */

import { getOriginPermissions, grantCapability, denyCapability } from '@repo/storage-chrome/origin';
import { hasCapability, isDenied, type Capability, CAPABILITY_META } from '@repo/storage-chrome/capabilities';

// pending pick requests: requestId → sendResponse callback
const pendingPicks = new Map<string, (r: unknown) => void>();

export const externalMessageListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
) => {
  if (typeof req !== 'object' || req === null || !('type' in req)) {
    sendResponse({ error: 'invalid message' });
    return true;
  }

  const msg = req as Record<string, unknown>;
  const type = msg['type'] as string;

  switch (type) {
    case 'ping':
      sendResponse({ zafu: true, version: chrome.runtime.getManifest().version });
      return true;

    case 'send': {
      const address = msg['address'];
      if (!address || typeof address !== 'string') {
        sendResponse({ error: 'address required' });
        return true;
      }
      const url = chrome.runtime.getURL(`popup.html#/send?to=${encodeURIComponent(address)}`);
      void chrome.windows.create({ url, type: 'popup', width: 400, height: 628 });
      sendResponse({ ok: true });
      return true;
    }

    case 'zafu_pick_contacts': {
      const appOrigin = sender.origin || sender.url || 'unknown';
      const purpose = String(msg['purpose'] || 'pick contacts');
      const max = Number(msg['max']) || 1;
      const requestId = crypto.randomUUID();

      // store the callback — picker popup will send result via internal message
      pendingPicks.set(requestId, sendResponse);

      // open picker popup with params
      const params = new URLSearchParams({
        app: appOrigin,
        purpose,
        max: String(max),
        requestId,
      });
      const url = chrome.runtime.getURL(`popup.html#/pick-contacts?${params.toString()}`);
      void chrome.windows.create({ url, type: 'popup', width: 400, height: 520 });

      // return true = async response (sendResponse called later from picker)
      return true;
    }

    case 'zafu_pick_contacts_result': {
      const requestId = String(msg['requestId'] || '');
      const callback = pendingPicks.get(requestId);
      if (callback) {
        callback({ success: true, contacts: msg['contacts'] || [] });
        pendingPicks.delete(requestId);
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'zafu_send_invite': {
      // TODO: resolve handle → pubkey, open e2ee channel, deliver payload
      sendResponse({ sent: false, error: 'invite delivery not yet implemented in extension' });
      return true;
    }

    case 'zafu_frost_create': {
      // open FROST DKG approval popup - user confirms creating a multisig
      const threshold = Number(msg['threshold']) || 2;
      const maxSigners = Number(msg['maxSigners']) || 3;
      const relayUrl = String(msg['relayUrl'] || 'https://zcash.rotko.net');
      const appOrigin = sender.origin || sender.url || 'unknown';
      const requestId = crypto.randomUUID();

      pendingPicks.set(requestId, sendResponse);

      const params = new URLSearchParams({
        app: appOrigin,
        action: 'frost-create',
        threshold: String(threshold),
        maxSigners: String(maxSigners),
        relayUrl,
        requestId,
      });
      const url = chrome.runtime.getURL(`popup.html#/frost-approve?${params.toString()}`);
      void chrome.windows.create({ url, type: 'popup', width: 400, height: 520 });
      return true;
    }

    case 'zafu_frost_join': {
      const roomCode = String(msg['roomCode'] || '');
      if (!roomCode) {
        sendResponse({ error: 'roomCode required' });
        return true;
      }
      const threshold = Number(msg['threshold']) || 2;
      const maxSigners = Number(msg['maxSigners']) || 3;
      const relayUrl = String(msg['relayUrl'] || 'https://zcash.rotko.net');
      const appOrigin = sender.origin || sender.url || 'unknown';
      const requestId = crypto.randomUUID();

      pendingPicks.set(requestId, sendResponse);

      const params = new URLSearchParams({
        app: appOrigin,
        action: 'frost-join',
        roomCode,
        threshold: String(threshold),
        maxSigners: String(maxSigners),
        relayUrl,
        requestId,
      });
      const url = chrome.runtime.getURL(`popup.html#/frost-approve?${params.toString()}`);
      void chrome.windows.create({ url, type: 'popup', width: 400, height: 520 });
      return true;
    }

    case 'zafu_frost_sign': {
      const roomCode = String(msg['roomCode'] || '');
      const sighashHex = String(msg['sighashHex'] || '');
      if (!roomCode || !sighashHex) {
        sendResponse({ error: 'roomCode and sighashHex required' });
        return true;
      }
      const relayUrl = String(msg['relayUrl'] || 'https://zcash.rotko.net');
      const appOrigin = sender.origin || sender.url || 'unknown';
      const requestId = crypto.randomUUID();

      pendingPicks.set(requestId, sendResponse);

      const params = new URLSearchParams({
        app: appOrigin,
        action: 'frost-sign',
        roomCode,
        sighashHex,
        relayUrl,
        requestId,
      });
      const url = chrome.runtime.getURL(`popup.html#/frost-approve?${params.toString()}`);
      void chrome.windows.create({ url, type: 'popup', width: 400, height: 520 });
      return true;
    }

    case 'zafu_frost_result': {
      // internal: frost approval popup sends result back
      const requestId = String(msg['requestId'] || '');
      const callback = pendingPicks.get(requestId);
      if (callback) {
        callback(msg['result'] || { error: 'no result' });
        pendingPicks.delete(requestId);
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'zafu_request_capability': {
      const capability = msg['capability'] as string;
      if (!capability || !(capability in CAPABILITY_META)) {
        sendResponse({ error: 'invalid capability' });
        return true;
      }
      const cap = capability as Capability;
      const origin = sender.origin || sender.url;
      if (!origin) {
        sendResponse({ error: 'unknown origin' });
        return true;
      }

      void (async () => {
        const perms = await getOriginPermissions(origin);

        // already granted
        if (hasCapability(perms, cap)) {
          sendResponse({ granted: true, capability: cap });
          return;
        }

        // previously denied
        if (isDenied(perms, cap)) {
          sendResponse({ granted: false, denied: true, capability: cap });
          return;
        }

        // open approval popup for this capability
        const requestId = crypto.randomUUID();
        const resultPromise = new Promise<unknown>(resolve => {
          pendingPicks.set(requestId, resolve);
        });

        const params = new URLSearchParams({
          app: origin,
          capability: cap,
          requestId,
          favIconUrl: sender.tab?.favIconUrl || '',
          title: sender.tab?.title || '',
        });
        const url = chrome.runtime.getURL(`popup.html#/approval/capability?${params.toString()}`);
        void chrome.windows.create({ url, type: 'popup', width: 400, height: 520 });

        const result = await resultPromise as { approved?: boolean };
        if (result?.approved) {
          await grantCapability(origin, cap);
          sendResponse({ granted: true, capability: cap });
        } else {
          await denyCapability(origin, cap);
          sendResponse({ granted: false, denied: true, capability: cap });
        }
      })();

      return true;
    }

    case 'zafu_capability_result': {
      // internal: capability approval popup sends result back
      const requestId = String(msg['requestId'] || '');
      const callback = pendingPicks.get(requestId);
      if (callback) {
        callback(msg['result'] || { approved: false });
        pendingPicks.delete(requestId);
      }
      sendResponse({ ok: true });
      return true;
    }

    // ── passkey / WebAuthn ──

    case 'zafu_passkey_create': {
      const { rpId, origin: reqOrigin } = msg as { rpId: string; origin: string };
      // TODO: show approval popup before creating credential
      // for now, auto-approve if origin has 'connect' capability
      void (async () => {
        try {
          const perms = await getOriginPermissions(reqOrigin);
          if (!hasCapability(perms, 'connect')) {
            sendResponse({ success: false, error: 'not connected' });
            return;
          }
          // lazy import to avoid loading webauthn.ts in every page load
          const { createCredential } = await import('../../state/webauthn');
          const { useStore } = await import('../../state');
          const keyInfo = useStore.getState().keyRing.keyInfo;
          if (!keyInfo) { sendResponse({ success: false }); return; }
          const mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);
          const result = createCredential(mnemonic, rpId);
          const { bytesToHex } = await import('@noble/hashes/utils');
          sendResponse({
            success: true,
            credentialId: bytesToHex(result.credentialId),
            authenticatorData: bytesToHex(result.authenticatorData),
            publicKey: bytesToHex(result.publicKey),
            prfEnabled: true,
          });
        } catch (e) {
          sendResponse({ success: false, error: String(e) });
        }
      })();
      return true;
    }

    case 'zafu_passkey_get': {
      const { rpId, prfSalts, origin: getOrigin } = msg as {
        rpId: string;
        prfSalts?: { first: string; second?: string };
        origin: string;
      };
      void (async () => {
        try {
          const perms = await getOriginPermissions(getOrigin);
          if (!hasCapability(perms, 'connect')) {
            sendResponse({ success: false, error: 'not connected' });
            return;
          }
          const { signAssertion, buildCredentialId } = await import('../../state/webauthn');
          const { useStore } = await import('../../state');
          const { sha256 } = await import('@noble/hashes/sha256');
          const { bytesToHex } = await import('@noble/hashes/utils');
          const keyInfo = useStore.getState().keyRing.keyInfo;
          if (!keyInfo) { sendResponse({ success: false }); return; }
          const mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);

          // clientDataHash will be computed by the content script's clientDataJSON
          // for now, use the challenge as a placeholder — the content script
          // constructs the real clientDataJSON
          const clientDataJSON = new TextEncoder().encode(JSON.stringify({
            type: 'webauthn.get',
            challenge: '', // filled by content script
            origin: getOrigin,
          }));
          const clientDataHash = sha256(clientDataJSON);

          const result = signAssertion(mnemonic, rpId, clientDataHash, prfSalts);
          sendResponse({
            success: true,
            credentialId: bytesToHex(buildCredentialId(rpId)),
            authenticatorData: bytesToHex(result.authenticatorData),
            signature: bytesToHex(result.signature),
            prfResults: result.prfResults ? {
              first: bytesToHex(result.prfResults.first),
              second: result.prfResults.second ? bytesToHex(result.prfResults.second) : undefined,
            } : undefined,
          });
        } catch (e) {
          sendResponse({ success: false, error: String(e) });
        }
      })();
      return true;
    }

    default:
      sendResponse({ error: 'unknown message type' });
      return true;
  }
};
