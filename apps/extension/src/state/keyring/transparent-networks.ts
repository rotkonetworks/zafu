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

// we'll use these libs when available:
// - @cosmjs for cosmos/ibc chains
// - @polkadot/util-crypto for substrate
// - ethers or viem for evm
// for now, stub the interface

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
    case 'osmosis':
    case 'noble':
    case 'nomic':
    case 'celestia':
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
    case 'osmosis':
    case 'noble':
    case 'nomic':
    case 'celestia':
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
  _mnemonic: string,
  accountIndex: number,
  ss58Prefix: number,
): Promise<TransparentWallet> => {
  // TODO: use @polkadot/util-crypto
  // const { mnemonicToMiniSecret, sr25519PairFromSeed, encodeAddress } = await import('@polkadot/util-crypto');
  // const seed = mnemonicToMiniSecret(_mnemonic);
  // const pair = sr25519PairFromSeed(seed);
  // const address = encodeAddress(pair.publicKey, ss58Prefix);

  // stub for now
  console.log(`[transparent] deriving ${network} address for account ${accountIndex}, ss58: ${ss58Prefix}`);
  return {
    network,
    address: `${ss58Prefix === 0 ? '1' : 'D'}stub${accountIndex}...`,
    publicKey: '0x...',
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
  _mnemonic: string,
  accountIndex: number,
): Promise<TransparentWallet> => {
  // TODO: use ethers or viem
  // import { HDNodeWallet } from 'ethers';
  // const path = `m/44'/60'/0'/0/${accountIndex}`;
  // const wallet = HDNodeWallet.fromMnemonic(_mnemonic, path);

  console.log(`[transparent] deriving ${network} address for account ${accountIndex}`);
  return {
    network,
    address: `0xstub${accountIndex}...`,
    publicKey: '0x...',
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
  _mnemonic: string,
  accountIndex: number,
): Promise<TransparentWallet> => {
  // TODO: use bitcoinjs-lib
  // import * as bitcoin from 'bitcoinjs-lib';
  // import { BIP32Factory } from 'bip32';
  // const path = `m/84'/0'/0'/0/${accountIndex}`;
  // derive native segwit (bc1...) address

  console.log(`[transparent] deriving ${network} address for account ${accountIndex}`);
  return {
    network,
    address: `bc1stub${accountIndex}...`,
    publicKey: '0x...',
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

