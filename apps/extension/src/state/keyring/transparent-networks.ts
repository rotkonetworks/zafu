/**
 * transparent and ibc network support
 *
 * these networks don't need local sync - just derive keys and query rpc
 * runs in main thread (no worker needed)
 *
 * IBC chains use cosmos SDK with secp256k1 keys
 * same mnemonic derives addresses for all cosmos chains (different bech32 prefix)
 */

import { type TransparentNetwork, type IbcNetwork, NETWORK_CONFIGS } from './network-types';

// derivation uses @repo/wallet per-network modules:
// - @repo/wallet/networks/polkadot/derive for substrate (ed25519/SLIP-10)
// - @repo/wallet/networks/ethereum/derive for EVM (secp256k1/BIP-44)
// - @repo/wallet/networks/bitcoin/derive for BTC (secp256k1/BIP-84, native segwit)
// - @repo/wallet/networks/cosmos/signer for cosmos/IBC chains

export interface TransparentWallet {
  network: TransparentNetwork | IbcNetwork;
  address: string;
  publicKey: string;
}

export interface BalanceResult {
  free: string;
  reserved?: string;
  frozen?: string;
}

/**
 * derive address for a transparent or IBC network
 * these are deterministic from mnemonic - no sync needed
 */
export const deriveTransparentAddress = async (
  network: TransparentNetwork | IbcNetwork,
  mnemonic: string,
  accountIndex = 0,
): Promise<TransparentWallet> => {
  const config = NETWORK_CONFIGS[network];

  switch (network) {
    // IBC/Cosmos chains - all use same derivation with different bech32 prefix
    case 'noble':
    case 'cosmoshub':
      return deriveCosmosAddress(network, mnemonic, accountIndex, config.bech32Prefix!);

    // Transparent networks
    case 'polkadot':
    case 'kusama':
      return deriveSubstrateAddress(network, mnemonic, accountIndex, config.ss58Prefix!);

    case 'ethereum':
      return deriveEvmAddress(network, mnemonic, accountIndex);

    case 'bitcoin':
      return deriveBitcoinAddress(network, mnemonic, accountIndex);

    default:
      throw new Error(`unsupported network: ${network}`);
  }
};

/**
 * get balance via rpc - no local state needed
 */
export const getTransparentBalance = async (
  network: TransparentNetwork | IbcNetwork,
  address: string,
  rpcUrl: string,
  denom?: string,
): Promise<BalanceResult> => {
  switch (network) {
    // IBC/Cosmos chains
    case 'noble':
    case 'cosmoshub':
      return getCosmosBalance(address, rpcUrl, denom);

    // Transparent networks
    case 'polkadot':
    case 'kusama':
      return getSubstrateBalance(address, rpcUrl);

    case 'ethereum':
      return getEvmBalance(address, rpcUrl);

    case 'bitcoin':
      return getBitcoinBalance(address, rpcUrl);

    default:
      throw new Error(`unsupported network: ${network}`);
  }
};

// --- substrate (polkadot/kusama) ---

const deriveSubstrateAddress = async (
  network: TransparentNetwork,
  mnemonic: string,
  accountIndex: number,
  _ss58Prefix: number,
): Promise<TransparentWallet> => {
  const { derivePolkadotWallet } = await import('@repo/wallet/networks/polkadot/derive');
  const substrateNetwork = network as 'polkadot' | 'kusama';
  const wallet = await derivePolkadotWallet(mnemonic, substrateNetwork, accountIndex);
  // clear private key from memory
  wallet.privateKey.fill(0);

  return {
    network,
    address: wallet.address,
    publicKey: bytesToHex(wallet.publicKey),
  };
};

const getSubstrateBalance = async (address: string, rpcUrl: string): Promise<BalanceResult> => {
  // TODO: use @polkadot/api or simple rpc
  // const response = await fetch(rpcUrl, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({
  //     jsonrpc: '2.0',
  //     id: 1,
  //     method: 'system_account',
  //     params: [address],
  //   }),
  // });

  console.log(`[transparent] querying substrate balance for ${address} via ${rpcUrl}`);
  return { free: '0', reserved: '0', frozen: '0' };
};

// --- evm (ethereum) ---

const deriveEvmAddress = async (
  network: TransparentNetwork,
  mnemonic: string,
  accountIndex: number,
): Promise<TransparentWallet> => {
  const { deriveEthWallet } = await import('@repo/wallet/networks/ethereum/derive');
  const wallet = await deriveEthWallet(mnemonic, accountIndex);
  // clear private key from memory
  wallet.privateKey.fill(0);

  return {
    network,
    address: wallet.address,
    publicKey: bytesToHex(wallet.publicKey),
  };
};

const getEvmBalance = async (address: string, rpcUrl: string): Promise<BalanceResult> => {
  // simple eth_getBalance rpc
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      }),
    });

    const data = await response.json();
    const balanceHex = data.result as string;
    const balance = BigInt(balanceHex).toString();

    return { free: balance };
  } catch (err) {
    console.error(`[transparent] evm balance error:`, err);
    return { free: '0' };
  }
};

// --- cosmos ---

const deriveCosmosAddress = async (
  network: IbcNetwork,
  mnemonic: string,
  _accountIndex: number,
  bech32Prefix: string,
): Promise<TransparentWallet> => {
  // use real derivation via @repo/wallet
  const { deriveCosmosWallet } = await import('@repo/wallet/networks/cosmos/signer');
  const wallet = await deriveCosmosWallet(mnemonic, 0, bech32Prefix);

  return {
    network,
    address: wallet.address,
    publicKey: bytesToHex(wallet.pubkey),
  };
};

/** convert bytes to hex string */
function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const getCosmosBalance = async (address: string, rpcUrl: string, denom?: string): Promise<BalanceResult> => {
  // cosmos lcd/rest api
  try {
    const response = await fetch(`${rpcUrl}/cosmos/bank/v1beta1/balances/${address}`);
    const data = await response.json();

    // find native token balance
    const balances = data.balances as { denom: string; amount: string }[];
    const targetDenom = denom ?? 'uatom';
    const native = balances.find(b => b.denom === targetDenom) ?? { amount: '0' };

    return { free: native.amount };
  } catch (err) {
    console.error(`[transparent] cosmos balance error:`, err);
    return { free: '0' };
  }
};

// --- bitcoin ---

const deriveBitcoinAddress = async (
  network: TransparentNetwork,
  mnemonic: string,
  accountIndex: number,
): Promise<TransparentWallet> => {
  const { deriveBtcWallet } = await import('@repo/wallet/networks/bitcoin/derive');
  const wallet = await deriveBtcWallet(mnemonic, accountIndex);
  // clear private key from memory
  wallet.privateKey.fill(0);

  return {
    network,
    address: wallet.address,
    publicKey: bytesToHex(wallet.publicKey),
  };
};

const getBitcoinBalance = async (address: string, rpcUrl: string): Promise<BalanceResult> => {
  // use blockstream or mempool.space api
  try {
    // mempool.space api
    const response = await fetch(`${rpcUrl}/api/address/${address}`);
    const data = await response.json();

    const balance = (data.chain_stats?.funded_txo_sum ?? 0) - (data.chain_stats?.spent_txo_sum ?? 0);
    return { free: balance.toString() };
  } catch (err) {
    console.error(`[transparent] bitcoin balance error:`, err);
    return { free: '0' };
  }
};

