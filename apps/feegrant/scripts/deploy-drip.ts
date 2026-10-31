/* eslint-disable no-console -- CLI output */
// Deploys the Drip contract from the Base sponsor key and prints its address
// and tx hash. Costs a little gas on Base; does nothing else.
//   BASE_KEY_FILE=... [BASE_RPC=...] bun scripts/deploy-drip.ts
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { DRIP_ABI, DRIP_BYTECODE } from '../src/drip-artifact';

const keyFile = process.env['BASE_KEY_FILE'];
if (!keyFile) {
  throw new Error('usage: BASE_KEY_FILE=<key-file> bun scripts/deploy-drip.ts');
}
const account = privateKeyToAccount(readFileSync(keyFile, 'utf8').trim() as `0x${string}`);
const transport = http(process.env['BASE_RPC'] ?? 'https://mainnet.base.org');
const wallet = createWalletClient({ account, chain: base, transport });
const reader = createPublicClient({ chain: base, transport });

const hash = await wallet.deployContract({ abi: DRIP_ABI, bytecode: DRIP_BYTECODE });
console.log(`tx ${hash}`);
const receipt = await reader.waitForTransactionReceipt({ hash });
console.log(`BASE_DRIP_CONTRACT=${receipt.contractAddress}`);
