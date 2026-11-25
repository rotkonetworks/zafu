/**
 * The evm chains a site may use zafu on. A site can only switch among these;
 * it cannot add its own (wallet_addEthereumChain of anything else is refused),
 * so zafu never talks to an rpc a page chose.
 *
 * `ibc` lists the ics20 / bridge contracts whose calls zafu spells out as a
 * move over ibc. A call of the same shape to any other contract is shown as
 * an unreadable call: a look-alike must never read as "into penumbra".
 *
 * `destination` is the egress opt-in that owns the chain's rpc. The local dev
 * chain has none: a node on this computer is not a third party (net/destination
 * isLocalDeviceHost), and it is offered only while beta features are on.
 */

export interface EvmChain {
  id: number;
  name: string;
  symbol: string;
  rpc: string;
  destination?: string;
  beta?: true;
  ibc: readonly string[];
}

/** the chapel eureka ICS20Transfer (brinance deployments/chapel.json `ics20`) */
const CHAPEL_ICS20: readonly string[] = ['0xAAffe45F7c9352188783f0d4D945c672788545A3'];

export const EVM_CHAINS: readonly EvmChain[] = [
  {
    id: 56,
    name: 'bnb smart chain',
    symbol: 'BNB',
    rpc: 'https://bsc-dataseed.bnbchain.org',
    destination: 'bsc',
    ibc: [],
  },
  {
    id: 97,
    name: 'bnb smart chain testnet',
    symbol: 'tBNB',
    rpc: 'https://bsc-testnet.publicnode.com',
    destination: 'bsc-testnet',
    ibc: CHAPEL_ICS20,
  },
  {
    id: 31337,
    name: 'local dev chain',
    symbol: 'ETH',
    rpc: 'http://127.0.0.1:8545',
    beta: true,
    // BrinanceTransfer, as anvil deploys it (brinance deployments/local.json)
    ibc: ['0x9A676e781A523b5d0C0e43731313A708CB607508'],
  },
];

export const DEFAULT_EVM_CHAIN = 56;

/**
 * The key a site connected through the evm provider sees and signs with. It
 * is its own BIP-44 account (1'), apart from every key zafu already uses on
 * coin type 60, all under account 0': Injective and the Base buy burner at
 * m/44'/60'/0'/0/0, and the Hyperliquid accounts at m/44'/60'/0'/0/n. So a
 * site never learns the address of those, and nothing they hold is one
 * approval away. Any evm wallet opens it from the phrase as account 2 (the
 * second account' level).
 */
export const DAPP_EVM_PATH = "m/44'/60'/1'/0/0";

/** the chain with this id, when a site may use it under the beta setting */
export const evmChain = (id: number, beta: boolean): EvmChain | undefined =>
  EVM_CHAINS.find(c => c.id === id && (!c.beta || beta));

/** `to` is one of this chain's known ics20 / bridge contracts */
export const isKnownBridge = (chain: Pick<EvmChain, 'ibc'>, to: string | undefined): boolean =>
  !!to && chain.ibc.some(a => a.toLowerCase() === to.toLowerCase());

/** an EIP-1193 chain id ("0x38") as a number; NaN for anything else */
export const parseChainId = (raw: unknown): number =>
  typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : NaN;

export const hexChainId = (id: number): string => `0x${id.toString(16)}`;
