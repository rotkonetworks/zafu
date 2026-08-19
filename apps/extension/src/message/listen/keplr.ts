/**
 * Service-worker handler for the Keplr provider. The heavy lifting that needs
 * the decrypted mnemonic (deriving an address, signing) happens in an approval
 * popup that has keyring access; this handler only orchestrates - opening the
 * popup, caching the derived key so subsequent getKey calls are silent (as in
 * real Keplr), and broadcasting.
 */

import { isValidExternalSender } from '../../senders/external';
import {
  isKeplrMessage,
  isKeplrApprovalResult,
  cosmosChainIdFromKeplr,
  keplrApprovalKey,
  keplrKeyCacheKey,
  type KeplrApprovalRequest,
  type KeplrWireKey,
} from '../keplr';
// NB: import only the lightweight chain CONFIG here, never the cosmos client -
// the client pulls @cosmjs/stargate -> crypto/bip39, a Node-only dependency the
// service-worker build can't resolve. We broadcast with a raw RPC fetch below.
import { COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { POPUP_WINDOW_WIDTH, POPUP_WINDOW_HEIGHT } from '../../utils/popup-window';

/** requestId -> resolver for an in-flight approval popup */
const pending = new Map<
  string,
  (payload: { approved: boolean; payload?: unknown; error?: string }) => void
>();

const bytesToB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s);
};

/** open a keplr approval popup and await the user's decision */
async function openApproval(
  req: KeplrApprovalRequest,
): Promise<{ approved: boolean; payload?: unknown; error?: string }> {
  await chrome.storage.session.set({ [keplrApprovalKey(req.requestId)]: req });
  const result = new Promise<{ approved: boolean; payload?: unknown; error?: string }>(resolve => {
    pending.set(req.requestId, resolve);
  });
  const params = new URLSearchParams({ requestId: req.requestId });
  const url = chrome.runtime.getURL(`popup.html#/approval/keplr?${params.toString()}`);
  const { top = 0, left = 0, width = 0 } = await chrome.windows.getLastFocused();
  void chrome.windows.create({
    url,
    type: 'popup',
    focused: true,
    width: POPUP_WINDOW_WIDTH,
    height: POPUP_WINDOW_HEIGHT,
    top: Math.max(0, top),
    left: Math.max(0, left + width - POPUP_WINDOW_WIDTH),
  });
  const decision = await result;
  void chrome.storage.session.remove(keplrApprovalKey(req.requestId));
  return decision;
}

/** enable: derive + cache the key(s) for the requested chains via one approval */
async function handleEnable(
  origin: string,
  chainIds: string[],
  meta: { favIconUrl?: string; title?: string },
) {
  const chainId = chainIds[0] ?? '';
  const decision = await openApproval({
    requestId: crypto.randomUUID(),
    method: 'enable',
    origin,
    chainId,
    signDoc: { chainIds },
    ...meta,
  });
  if (!decision.approved) {
    throw new Error(decision.error ?? 'connection rejected');
  }
  // popup returns the derived keys keyed by chainId; cache them for silent getKey
  const keys = (decision.payload as { keys?: Record<string, KeplrWireKey> })?.keys ?? {};
  const patch: Record<string, KeplrWireKey> = {};
  for (const [cid, key] of Object.entries(keys)) {
    patch[keplrKeyCacheKey(origin, cid)] = key;
  }
  if (Object.keys(patch).length > 0) {
    await chrome.storage.session.set(patch);
  }
}

async function getCachedKey(origin: string, chainId: string): Promise<KeplrWireKey | undefined> {
  const k = keplrKeyCacheKey(origin, chainId);
  const stored = await chrome.storage.session.get(k);
  return stored[k] as KeplrWireKey | undefined;
}

async function handleMethod(
  method: string,
  params: Record<string, unknown>,
  origin: string,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const meta = { favIconUrl: sender.tab?.favIconUrl ?? '', title: sender.tab?.title ?? '' };

  switch (method) {
    case 'enable': {
      const chainIds = (params['chainIds'] as string[]) ?? [];
      await handleEnable(origin, chainIds, meta);
      return {};
    }

    case 'disable': {
      // drop cached keys for this origin
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter(k => k.startsWith(`keplrKey:${origin}:`));
      if (keys.length > 0) {
        await chrome.storage.session.remove(keys);
      }
      return {};
    }

    case 'getKey': {
      const chainId = String(params['chainId'] ?? '');
      let key = await getCachedKey(origin, chainId);
      if (!key) {
        // not enabled for this chain yet - prompt now, then read the cache
        await handleEnable(origin, [chainId], meta);
        key = await getCachedKey(origin, chainId);
      }
      if (!key) {
        throw new Error('no key for chain');
      }
      return key;
    }

    case 'experimentalSuggestChain': {
      // record the suggestion; we do not maintain a live chain registry, so
      // accepting is enough for dapps that gate on it
      const chainInfo = params['chainInfo'];
      await chrome.storage.session.set({ [`keplrSuggested:${origin}`]: chainInfo });
      return {};
    }

    case 'signAmino':
    case 'signDirect': {
      const chainId = String(params['chainId'] ?? '');
      const decision = await openApproval({
        requestId: crypto.randomUUID(),
        method,
        origin,
        chainId,
        signerAddress: String(params['signerAddress'] ?? ''),
        signDoc: params['signDoc'],
        ...meta,
      });
      if (!decision.approved) {
        throw new Error(decision.error ?? 'signature rejected');
      }
      return decision.payload;
    }

    case 'sendTx': {
      const chainId = String(params['chainId'] ?? '');
      const cosmosId = cosmosChainIdFromKeplr(chainId);
      if (!cosmosId) {
        throw new Error(`unsupported chain ${chainId}`);
      }
      // Raw Tendermint RPC broadcast_tx_sync - avoids bundling the stargate
      // client into the service worker. params.tx is base64, which is exactly
      // the txB64 we already carry.
      const rpc = COSMOS_CHAINS[cosmosId].rpcEndpoint;
      const resp = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'broadcast_tx_sync',
          params: { tx: String(params['txB64'] ?? '') },
        }),
      });
      const json = (await resp.json()) as {
        result?: { code?: number; hash?: string; log?: string };
        error?: { message?: string };
      };
      if (json.error) {
        throw new Error(json.error.message ?? 'broadcast failed');
      }
      const result = json.result;
      if (!result || (result.code ?? 0) !== 0) {
        throw new Error(result?.log || `broadcast rejected (code ${result?.code})`);
      }
      // Tendermint returns an uppercase hex hash; keplr wants the raw bytes
      const hex = result.hash ?? '';
      const bytes = Uint8Array.from(hex.match(/.{1,2}/g)?.map(h => parseInt(h, 16)) ?? []);
      return { hashB64: bytesToB64(bytes) };
    }

    default:
      throw new Error(`unsupported method ${method}`);
  }
}

/** runtime.onMessage listener for the content-script bridge */
export const keplrMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean => {
  // the approval popup posting its result back
  if (isKeplrApprovalResult(message)) {
    const resolve = pending.get(message.requestId);
    if (resolve) {
      pending.delete(message.requestId);
      resolve(
        message.result.approved
          ? { approved: true, payload: message.result.payload }
          : { approved: false, error: message.result.error },
      );
    }
    sendResponse({ ok: true });
    return false;
  }

  if (!isKeplrMessage(message)) {
    return false;
  }
  // the bridge is a content script - validate it is a real web sender
  if (!isValidExternalSender(sender)) {
    sendResponse({ ok: false, error: 'invalid sender' });
    return false;
  }

  void handleMethod(
    message.method,
    (message.params as Record<string, unknown>) ?? {},
    message.origin,
    sender,
  )
    .then(result => sendResponse({ ok: true, result }))
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : 'request failed' }),
    );
  return true; // async response
};
