/**
 * Service-worker handler for the Keplr provider. The heavy lifting that needs
 * the decrypted mnemonic (deriving an address, signing) happens in an approval
 * popup that has keyring access; this handler only orchestrates - opening the
 * popup, caching the derived key so subsequent getKey calls are silent (as in
 * real Keplr), and broadcasting.
 */

import { isValidExternalSender } from '../../senders/external';
import { isValidInternalSender } from '../../senders/internal';
import {
  isKeplrMessage,
  isKeplrApprovalResult,
  cosmosChainIdFromKeplr,
  keplrApprovalKey,
  keplrKeyCacheKey,
  keplrSuggestedKey,
  signedChainId,
  suggestedPrefix,
  type KeplrApprovalRequest,
  type KeplrWireKey,
} from '../keplr';
// NB: import only the lightweight chain CONFIG here, never the cosmos client -
// the client pulls @cosmjs/stargate -> crypto/bip39, a Node-only dependency the
// service-worker build can't resolve. We broadcast with a raw RPC fetch below.
import { getCosmosChain } from '@repo/wallet/networks/cosmos/chains';
import {
  adr036SignDoc,
  verifyAdr036,
  type StdSignatureWire,
} from '@repo/wallet/networks/cosmos/adr036';
import { releasePopupGuardForRequest, takePendingApproval } from './external-easteregg';
import { askInWindow } from './approval-window';

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const bytesToB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s);
};

const openApproval = (req: KeplrApprovalRequest) =>
  askInWindow('approval/keplr', keplrApprovalKey(req.requestId), req);

/** each site's enables, one after another: the second sees what the first was given */
const enabling = new Map<string, Promise<void>>();

/**
 * enable: ask once for the chains this site does not have yet, as real Keplr
 * does. A site that enables every chain and then reads each key at once (as
 * cosmos-kit does) would otherwise be asked again for a chain it was just given.
 */
function handleEnable(
  origin: string,
  chainIds: string[],
  meta: { favIconUrl?: string; title?: string },
): Promise<void> {
  const run = (enabling.get(origin) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => enableMissing(origin, chainIds, meta));
  enabling.set(origin, run);
  void run
    .finally(() => enabling.get(origin) === run && enabling.delete(origin))
    .catch(() => undefined);
  return run;
}

/** derive + cache the key(s) for the requested chains this site lacks, via one approval */
async function enableMissing(
  origin: string,
  requested: string[],
  meta: { favIconUrl?: string; title?: string },
) {
  const chainIds: string[] = [];
  for (const cid of requested) {
    if (!(await getCachedKey(origin, cid))) {
      chainIds.push(cid);
    }
  }
  if (!chainIds.length) {
    return;
  }
  const chainId = chainIds[0] ?? '';
  const decision = await openApproval({
    requestId: crypto.randomUUID(),
    method: 'enable',
    origin,
    chainId,
    signDoc: { chainIds },
    prefixes: await suggestedPrefixes(origin, chainIds),
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

/** prefixes this site suggested for the chains zafu doesn't know; a built-in chain keeps its own */
async function suggestedPrefixes(origin: string, chainIds: string[]) {
  const prefixes: Record<string, string> = {};
  for (const cid of chainIds.filter(cid => !cosmosChainIdFromKeplr(cid))) {
    const k = keplrSuggestedKey(origin, cid);
    const prefix: unknown = (await chrome.storage.session.get(k))[k];
    if (typeof prefix === 'string') {
      prefixes[cid] = prefix;
    }
  }
  return prefixes;
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

  // FUND SAFETY: Ethermint chains (eth_secp256k1 / coin type 60, e.g. Injective)
  // must NEVER be served over the Keplr provider. Keplr derivation goes through
  // the shared cosmos coin-118 path, which produces a plausible-looking but WRONG
  // (unspendable) inj1 address and cosmos-style signatures the chain rejects.
  // Fail closed for every chain-bearing method (checking ALL requested chainIds);
  // the real Injective flow is the dedicated in-wallet conduit UI.
  const requestedChains: string[] =
    method === 'enable'
      ? ((params['chainIds'] as string[] | undefined) ?? [])
      : params['chainId'] !== undefined
        ? [String(params['chainId'])]
        : [];
  for (const cid of requestedChains) {
    const resolved = cosmosChainIdFromKeplr(cid);
    if (resolved && getCosmosChain(resolved).keyAlgo === 'eth_secp256k1') {
      throw new Error(
        `unsupported chain ${cid}: Ethermint chains are not served over Keplr; use the in-wallet flow`,
      );
    }
  }

  // the chain that gets signed is the one inside the doc; a site that names
  // another in params would have the person approve one chain and sign on another
  if (method === 'signAmino' || method === 'signDirect') {
    const signed = signedChainId(method, params['signDoc']);
    if (signed === undefined || signed !== String(params['chainId'] ?? '')) {
      throw new Error("this request names one chain and signs on another · zafu won't sign it");
    }
  }

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
      // record the suggestion per site and chain; we do not maintain a live
      // chain registry, so accepting is enough for dapps that gate on it, and
      // its account prefix is what an enable of that chain derives with
      const chainInfo = params['chainInfo'];
      const chainId = (chainInfo as { chainId?: unknown } | undefined)?.chainId;
      if (typeof chainId !== 'string' || !chainId) {
        throw new Error('a suggested chain needs a chain id');
      }
      // only the checked prefix is kept, never the site's whole chain description
      const prefix = suggestedPrefix(chainInfo);
      if (prefix) {
        await chrome.storage.session.set({ [keplrSuggestedKey(origin, chainId)]: prefix });
      }
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

    // ADR-036: an off-chain signature over bytes the site chose, approved as a message
    case 'signArbitrary': {
      const chainId = String(params['chainId'] ?? '');
      const signerAddress = String(params['signerAddress'] ?? '');
      const decision = await openApproval({
        requestId: crypto.randomUUID(),
        method,
        origin,
        chainId,
        signerAddress,
        signDoc: adr036SignDoc(signerAddress, b64ToBytes(String(params['dataB64'] ?? ''))),
        ...meta,
      });
      if (!decision.approved) {
        throw new Error(decision.error ?? 'signature rejected');
      }
      return decision.payload;
    }

    // checks a signature only, with no key and no prompt
    case 'verifyArbitrary': {
      const chainId = String(params['chainId'] ?? '');
      const cosmosId = cosmosChainIdFromKeplr(chainId);
      if (!cosmosId) {
        throw new Error(`unsupported chain ${chainId}`);
      }
      return verifyAdr036(
        getCosmosChain(cosmosId).bech32Prefix,
        String(params['signerAddress'] ?? ''),
        b64ToBytes(String(params['dataB64'] ?? '')),
        params['signature'] as StdSignatureWire,
      );
    }

    case 'sendTx': {
      const chainId = String(params['chainId'] ?? '');
      const cosmosId = cosmosChainIdFromKeplr(chainId);
      if (!cosmosId) {
        throw new Error(`unsupported chain ${chainId}`);
      }
      // only a site the person connected to this chain: otherwise any page
      // could have zafu reach a chain node on its behalf, unasked
      if (!(await getCachedKey(origin, chainId))) {
        throw new Error(`this site isn't connected to ${chainId} · please connect first`);
      }
      // Raw Tendermint RPC broadcast_tx_sync - avoids bundling the stargate
      // client into the service worker. params.tx is base64, which is exactly
      // the txB64 we already carry.
      const rpc = getCosmosChain(cosmosId).rpcEndpoint;
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
  // an approval window posting its result back (the keplr and evm screens,
  // see approval-window.ts) - only from zafu's own pages:
  // a content script carries this extension's id too, and a forged result
  // would answer an approval the person never saw
  if (isKeplrApprovalResult(message)) {
    if (!isValidInternalSender(sender)) {
      return false;
    }
    takePendingApproval(message.requestId)?.(message.result);
    // the decision is in: the site may ask again (enable, then sign) before the window is gone
    releasePopupGuardForRequest(message.requestId);
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

  // the origin is the browser-attested sender's, never a field of the message:
  // the page writes the message, so it could name a site the person trusts
  void handleMethod(
    message.method,
    (message.params as Record<string, unknown>) ?? {},
    sender.origin,
    sender,
  )
    .then(result => sendResponse({ ok: true, result }))
    .catch((err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : 'request failed' }),
    );
  return true; // async response
};
