/**
 * Why zafu is about to talk to a host.
 *
 * A destination is only meaningful together with the reason for contacting it:
 * "zafu connects to <host>" is not a question a user can answer, "zafu connects
 * to <host> to fetch your Zcash blocks" is. The purpose is recorded per
 * destination (all purposes ever seen), shown in the consent prompt and in the
 * settings audit list, and is what makes a denial legible months later.
 *
 * The set is closed on purpose: a free-text field would drift into
 * meaningless values, and the prompt needs a vocabulary it can render without
 * interpretation.
 */
export type NetPurpose =
  /** chain node: Zcash lightwalletd, Penumbra view service, cosmos/CosmWasm rpc */
  | 'chain-rpc'
  /** indexer in front of a chain: zidecar, hosh tip, your own node */
  | 'indexer'
  /** store-and-forward for other people's traffic: contact discovery, FROST rendezvous, group chat */
  | 'relay'
  /** asset/brand metadata and denom lists (bundled copy is the fallback) */
  | 'registry'
  /** fiat price feeds */
  | 'price'
  /** governance voting service */
  | 'vote'
  /** swap aggregators (NEAR 1Click) */
  | 'swap'
  /** extension update manifests */
  | 'ota'
  /** license/zid server */
  | 'license'
  /** proving/verification keys and wasm build params */
  | 'attest'
  /** a device on this machine: the ledger/speculos bridge, a local test node */
  | 'local-device'
  /** anything not yet classified - the honest default, never a silent allow */
  | 'other';

export const NET_PURPOSES: readonly NetPurpose[] = [
  'chain-rpc',
  'indexer',
  'relay',
  'registry',
  'price',
  'vote',
  'swap',
  'ota',
  'license',
  'attest',
  'local-device',
  'other',
];

/**
 * What the prompt says the connection is for. Written for a reader who does not
 * know what a lightwalletd is: the first clause names the function, the second
 * names the consequence of saying no where that is not obvious.
 */
export const NET_PURPOSE_LABEL: Record<NetPurpose, string> = {
  'chain-rpc': 'read chain data (blocks, balances, transaction status)',
  indexer: 'read indexed chain data (sync progress, block history)',
  relay: 'send and receive your messages through a relay',
  registry: 'fetch asset and network metadata',
  price: 'fetch fiat prices',
  vote: 'cast and read governance votes',
  swap: 'quote and execute swaps',
  ota: 'check for extension updates',
  license: 'verify your license',
  attest: 'fetch proving parameters',
  'local-device': 'talk to a device on this computer',
  other: 'make a network request',
};

/** Storage holds a purpose only if it is one we can render. */
export const parseNetPurpose = (raw: unknown): NetPurpose =>
  typeof raw === 'string' && (NET_PURPOSES as readonly string[]).includes(raw)
    ? (raw as NetPurpose)
    : 'other';
