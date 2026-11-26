/**
 * Service-worker handler for the evm provider (EIP-1193). One table maps each
 * method a site may call to its handler; anything else is refused with 4200.
 *
 * Keys stay here: the key (its own path, evm/chains DAPP_EVM_PATH) is
 * derived in this worker for one signature and zeroed (evm/tx
 * withDappAccount), and a site only ever gets back an address, a signature
 * or a transaction hash. The approval window shows what
 * is asked and answers yes or no; it never signs.
 *
 * The person's consent rides the existing per-site permissions (capability
 * `evm`), separate from `connect`, so an evm connection never opens penumbra
 * to the site. A chain's rpc is reached only once the person allowed its
 * egress destination, asked in the connect window.
 */

import type { Client } from '@connectrpc/connect';
import type { ViewService } from '@penumbra-zone/protobuf';
import { addressFromBech32m } from '@penumbra-zone/bech32m/penumbra';
import { decodeFunctionResult, encodeFunctionData, erc20Abi, isHex, toHex, type Hex } from 'viem';
import { getOriginPermissions, grantCapability } from '@repo/storage-chrome/origin';
import { hasCapability, isDenied } from '@repo/storage-chrome/capabilities';
import { localExtStorage } from '@repo/storage-chrome/local';
import { isValidExternalSender } from '../../senders/external';
import { walletKind, type WalletKind } from '../../signing/wallet-kind';
import type { EncryptedVault } from '../../state/keyring/types';
import { betaOn } from '../../config/beta';
import { getCapabilityMode } from '../../state/capability-modes';
import { readEgressView } from '../../net/egress-opt-in';
import {
  DEFAULT_EVM_CHAIN,
  evmChain,
  hexChainId,
  knownBridge,
  parseChainId,
  type EvmChain,
} from '../../evm/chains';
import {
  isPenumbraReceiver,
  readCall,
  tokenAddress,
  type CallView,
  type Owner,
} from '../../evm/calldata';
import {
  EvmError,
  REJECTED,
  UNAUTHORIZED,
  UNKNOWN_CHAIN,
  UNSUPPORTED,
  fillTx,
  rpcAt,
  signAndSend,
  storeTx,
  withDappAccount,
  type EvmAccount,
  type Rpc,
  type TxParams,
} from '../../evm/tx';
import { evmApprovalKey, isEvmMessage, type EvmApprovalRequest } from '../evm';
import { unlockedMnemonic } from './unlocked-mnemonic';
import { askInWindow } from './approval-window';

interface Site {
  origin: string;
  title?: string;
  favIconUrl?: string;
}

/** whose a penumbra address is, by the active wallet's view service */
export type Whose = (receiver: string) => Promise<Owner>;

/** one request: the browser-attested site, and what its handlers may ask of zafu */
export interface Ctx {
  site: Site;
  whose: Whose;
}

/** lends the selected wallet's evm account for one call */
type Signer = <T>(origin: string, fn: (account: EvmAccount) => Promise<T>) => Promise<T>;

/** who signs evm for each kind of wallet; a kind not here cannot, and says so */
const SIGNERS: Partial<Record<WalletKind, Signer>> = {
  hot: async (origin, fn) => {
    const mnemonic = await unlockedMnemonic(origin);
    if (!mnemonic) {
      throw new EvmError(UNAUTHORIZED, 'zafu is locked · please unlock and try again');
    }
    return withDappAccount(mnemonic, fn);
  },
};

const selectedSigner = async (): Promise<{ id: string; sign: Signer }> => {
  const vaults = ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
  const selectedId = await localExtStorage.get('selectedVaultId');
  const vault = vaults.find(v => v.id === selectedId);
  const sign = vault && SIGNERS[walletKind(vault)];
  if (!vault || !sign) {
    throw new EvmError(
      UNAUTHORIZED,
      "this wallet can't sign on evm chains in zafu yet · a recovery phrase wallet can",
    );
  }
  return { id: vault.id, sign };
};

const session = async <T>(key: string): Promise<T | undefined> =>
  (await chrome.storage.session.get(key))[key] as T | undefined;

/** the wallet's evm address; derived (unlocking first) only when `interactive` */
const addressOf = async (origin: string, interactive: boolean): Promise<Hex | undefined> => {
  const { id, sign } = await selectedSigner();
  const key = `evmAddress:${id}`;
  const cached = await session<Hex>(key);
  if (cached || !interactive) {
    return cached;
  }
  const address = await sign(origin, a => Promise.resolve(a.address));
  await chrome.storage.session.set({ [key]: address });
  return address;
};

const beta = async (): Promise<boolean> => betaOn(await localExtStorage.get('betaFeatures'));

const chainKey = (origin: string) => `evmChain:${origin}`;

/** the chain this site is on; bnb smart chain until it switches */
const currentChain = async (origin: string): Promise<EvmChain> =>
  evmChain((await session<number>(chainKey(origin))) ?? DEFAULT_EVM_CHAIN, await beta()) ??
  evmChain(DEFAULT_EVM_CHAIN, false)!;

/** the person allowed zafu to reach this chain's rpc */
const reachable = async (chain: EvmChain): Promise<boolean> =>
  !chain.destination || !!(await readEgressView()).find(d => d.id === chain.destination && d.on);

/**
 * The wallet this site connected with, while it is still the selected one. A
 * connection is to one wallet (audit F-3): after a switch the site sees no
 * accounts until it asks again, so it never learns that two wallets are one
 * person's.
 */
const connectedVault = async (origin: string): Promise<string | undefined> => {
  if (
    (await getCapabilityMode('evm')) === 'disabled' ||
    !hasCapability(await getOriginPermissions(origin), 'evm')
  ) {
    return undefined;
  }
  const vault = ((await localExtStorage.get('evmSites')) ?? {})[origin];
  return vault !== undefined && vault === (await localExtStorage.get('selectedVaultId'))
    ? vault
    : undefined;
};

const connected = async (origin: string): Promise<boolean> =>
  (await connectedVault(origin)) !== undefined;

/** the wallet this site connected with; refused when there is none */
const requireConnected = async (origin: string): Promise<string> => {
  const vault = await connectedVault(origin);
  // otherwise any page could have zafu reach a node on its behalf, unasked
  if (vault === undefined) {
    throw new EvmError(UNAUTHORIZED, "this site isn't connected to zafu · please connect first");
  }
  return vault;
};

const connect = async (origin: string, vault: string): Promise<void> => {
  await grantCapability(origin, 'evm');
  const sites = (await localExtStorage.get('evmSites')) ?? {};
  await localExtStorage.set('evmSites', { ...sites, [origin]: vault });
};

type Ask = Omit<EvmApprovalRequest, 'requestId' | keyof Site>;

/** after "not now", a site's next ask in this long is answered no without a window */
const BACKOFF_MS = 30_000;
// in session storage, not memory: the worker restarting must not reopen the loop
const declinedKey = (origin: string) => `evmDeclined:${origin}`;

const ask = async (site: Site, part: Ask): Promise<void> => {
  if (Date.now() - ((await session<number>(declinedKey(site.origin))) ?? -Infinity) < BACKOFF_MS) {
    throw new EvmError(REJECTED, 'you said not now · zafu will ask again in a little while');
  }
  const req: EvmApprovalRequest = { requestId: crypto.randomUUID(), ...site, ...part };
  const decision = await askInWindow('approval/evm', evmApprovalKey(req.requestId), req);
  if (!decision.approved) {
    await chrome.storage.session.set({ [declinedKey(site.origin)]: Date.now() });
    throw new EvmError(REJECTED, decision.error ?? 'request rejected');
  }
};

/** the token's own symbol and decimals, when the call names an amount of one */
const tokenOf = async (rpc: Rpc, view: CallView, to: Hex | undefined) => {
  const token = tokenAddress(view, to);
  if (!token) {
    return undefined;
  }
  const read = (functionName: 'symbol' | 'decimals') =>
    rpc('eth_call', [
      { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName }) },
      'latest',
    ]).then(data => decodeFunctionResult({ abi: erc20Abi, functionName, data: data as Hex }));
  try {
    const [symbol, decimals] = await Promise.all([read('symbol'), read('decimals')]);
    return { symbol: String(symbol), decimals: Number(decimals) };
  } catch {
    // not a token that answers: the amount is shown in its smallest unit
    return undefined;
  }
};

/** whose the penumbra receiver of an ibc move is; nothing to check for any other call */
const ownerOf = (view: CallView, whose: Whose): Promise<Owner> =>
  view.kind === 'ibc' && isPenumbraReceiver(view.receiver)
    ? whose(view.receiver)
    : Promise.resolve(undefined);

/**
 * The view service's answer: an address of this wallet comes back with its
 * index, a one-time one with a randomizer. No answer in time (penumbra still
 * starting, or not set up) is "couldn't check", never "yours".
 */
export const penumbraOwner =
  (getViewClient: () => Promise<Client<typeof ViewService>>): Whose =>
  async receiver => {
    try {
      const asked = getViewClient().then(c =>
        c.indexByAddress({ address: addressFromBech32m(receiver) }),
      );
      const late = new Promise<never>((_, reject) => setTimeout(reject, 3000));
      const { addressIndex } = await Promise.race([asked, late]);
      if (!addressIndex) {
        return 'not-yours';
      }
      return addressIndex.randomizer.some(b => b !== 0) ? 'one-time' : 'account';
    } catch {
      return undefined;
    }
  };

const sameAddress = (a: unknown, b: string) =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Sign with the wallet this site connected with, as the address it was
 * shown. The person can switch wallets while the window is open: the selected
 * wallet is read again here, at the moment of signing, and must still be the
 * connected one, and its key must still be the address that was approved.
 */
const signAs = async <T>(
  origin: string,
  vault: string,
  from: Hex,
  fn: (a: EvmAccount) => Promise<T>,
): Promise<T> => {
  const now = await selectedSigner();
  if (now.id !== vault) {
    throw new EvmError(UNAUTHORIZED, 'the wallet changed while this was open · nothing was signed');
  }
  return now.sign(origin, a => {
    if (!sameAddress(a.address, from)) {
      throw new EvmError(
        UNAUTHORIZED,
        'the wallet changed while this was open · nothing was signed',
      );
    }
    return fn(a);
  });
};

type Handler = (params: unknown[], ctx: Ctx) => Promise<unknown>;

/**
 * Every refusal before a window opens reads the same, so a site that isn't
 * connected learns nothing about this wallet: not whether it can sign evm,
 * not whether evm is off, not whether it was turned away before.
 */
const NOT_CONNECTING = () => new EvmError(UNAUTHORIZED, "zafu can't connect this site");

const requestAccounts: Handler = async (_, { site }) => {
  const turnedAway =
    (await getCapabilityMode('evm')) === 'disabled' ||
    isDenied(await getOriginPermissions(site.origin), 'evm') ||
    !(await selectedSigner().then(
      () => true,
      () => false,
    ));
  if (turnedAway) {
    throw NOT_CONNECTING();
  }
  const chain = await currentChain(site.origin);
  if (!(await connected(site.origin)) || !(await reachable(chain))) {
    await ask(site, { kind: 'connect', chain });
    // the wallet selected when the person said yes
    await connect(site.origin, (await selectedSigner()).id);
  }
  return [await addressOf(site.origin, true)];
};

/** tell every open tab of this site, through its bridge, of an EIP-1193 event */
const tellTabs = async (origin: string, event: string, value: unknown): Promise<void> => {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined && tab.url && new URL(tab.url).origin === origin) {
      void chrome.tabs
        .sendMessage(tab.id, { type: 'ZafuEvmEvent', event, value })
        .catch(() => undefined);
    }
  }
};

/** the person switched wallet: every site connected with another one loses its accounts */
export const vaultSwitched = async (vault: string | undefined): Promise<void> => {
  for (const [origin, connectedWith] of Object.entries(
    (await localExtStorage.get('evmSites')) ?? {},
  )) {
    if (connectedWith !== vault) {
      await tellTabs(origin, 'accountsChanged', []);
    }
  }
};

const switchChain: Handler = async ([arg], { site }) => {
  const raw = (arg as { chainId?: unknown } | undefined)?.chainId;
  const chain = evmChain(parseChainId(raw), await beta());
  if (!chain) {
    throw new EvmError(UNKNOWN_CHAIN, `zafu doesn't offer chain ${String(raw)}`);
  }
  if ((await connected(site.origin)) && !(await reachable(chain))) {
    await ask(site, { kind: 'connect', chain });
  }
  // audit F-9: the local node is behind no opt-in, so a site asks once per session
  const localKey = `evmLocal:${site.origin}`;
  if (chain.local && !(await session<boolean>(localKey))) {
    await ask(site, { kind: 'chain', chain });
    await chrome.storage.session.set({ [localKey]: true });
  }
  const was = (await currentChain(site.origin)).id;
  await chrome.storage.session.set({ [chainKey(site.origin)]: chain.id });
  if (was !== chain.id) {
    await tellTabs(site.origin, 'chainChanged', hexChainId(chain.id));
  }
  return null;
};

const sendTransaction: Handler = async ([arg], { site, whose }) => {
  const vault = await requireConnected(site.origin);
  const from = (await addressOf(site.origin, true))!;
  const chain = await currentChain(site.origin);
  const rpc = rpcAt(chain.rpc);
  const tx = await fillTx(rpc, chain.id, from, (arg ?? {}) as TxParams);
  const view = readCall(tx.data, knownBridge(chain, tx.to));
  const [token, owner] = await Promise.all([tokenOf(rpc, view, tx.to), ownerOf(view, whose)]);
  await ask(site, { kind: 'send', chain, from, tx: storeTx(tx), token, owner });
  return signAs(site.origin, vault, from, a => signAndSend(rpc, a, tx));
};

const personalSign: Handler = async ([raw, address], { site }) => {
  const vault = await requireConnected(site.origin);
  const from = (await addressOf(site.origin, true))!;
  if (address !== undefined && !sameAddress(address, from)) {
    throw new EvmError(UNAUTHORIZED, 'this message names an address zafu did not give this site');
  }
  const message = typeof raw === 'string' && isHex(raw) ? raw : toHex(String(raw));
  await ask(site, { kind: 'sign', chain: await currentChain(site.origin), from, message });
  return signAs(site.origin, vault, from, a => a.signMessage({ message: { raw: message } }));
};

/** reads go to the site's chain as they are, once the site is connected */
const READS = [
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getCode',
  'eth_getLogs',
  'eth_getTransactionCount',
];

const read =
  (method: string): Handler =>
  async (params, { site }) => {
    await requireConnected(site.origin);
    return rpcAt((await currentChain(site.origin)).rpc)(method, params);
  };

export const HANDLERS: Readonly<Record<string, Handler>> = {
  eth_chainId: async (_, { site }) => hexChainId((await currentChain(site.origin)).id),
  net_version: async (_, { site }) => String((await currentChain(site.origin)).id),
  eth_accounts: async (_, { site }) => {
    const address =
      (await connected(site.origin)) &&
      (await addressOf(site.origin, false).catch(() => undefined));
    return address ? [address] : [];
  },
  eth_requestAccounts: requestAccounts,
  wallet_switchEthereumChain: switchChain,
  // only a chain zafu already offers: adding one is switching to it
  wallet_addEthereumChain: switchChain,
  eth_sendTransaction: sendTransaction,
  personal_sign: personalSign,
  ...Object.fromEntries(READS.map(m => [m, read(m)])),
};

export const evmRequest = (method: string, params: unknown, ctx: Ctx): Promise<unknown> => {
  const handler = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined;
  if (!handler) {
    return Promise.reject(new EvmError(UNSUPPORTED, `zafu doesn't support ${method}`));
  }
  return handler(Array.isArray(params) ? params : [], ctx);
};

/** runtime.onMessage listener for the content-script bridge */
export const createEvmMessageListener =
  (whose: Whose) =>
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (!isEvmMessage(message)) {
      return false;
    }
    if (!isValidExternalSender(sender)) {
      sendResponse({ ok: false, code: UNAUTHORIZED, error: 'invalid sender' });
      return false;
    }
    // the origin is the browser-attested sender's, never a field of the message
    const site = {
      origin: sender.origin,
      title: sender.tab.title ?? '',
      favIconUrl: sender.tab.favIconUrl ?? '',
    };
    void evmRequest(message.method, message.params, { site, whose }).then(
      result => sendResponse({ ok: true, result }),
      (err: unknown) =>
        sendResponse({
          ok: false,
          code: err instanceof EvmError ? err.code : -32603,
          error:
            err instanceof Error
              ? err.message
              : 'something went wrong in zafu · nothing was signed',
        }),
    );
    return true;
  };
