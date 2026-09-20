/**
 * Sweep the leftover INJ from the #34 round-trip throwaway address to another
 * account (e.g. the second hermes relayer, to top up its gas for keeping the
 * inj<->penumbra client updated).
 *
 * This SENDS real funds to INJ_DEST. Run it yourself; the amount is
 * (balance - fee), a bank MsgSend from the throwaway key to INJ_DEST.
 *
 *   INJ_DEST=<relayer inj1...> cd packages/wallet && npx tsx scripts/inj-sweep.mts
 *
 * Refuses to run without INJ_DEST (no default -> can't accidentally send).
 */
import { readFileSync, existsSync } from 'node:fs';
import { deriveInjectiveWallet } from '../src/networks/injective/derive';
import { queryInjectiveAccount, broadcastInjectiveTx } from '../src/networks/injective/client';
import { withdrawToExchange } from '../src/networks/injective/conduit';

const LCD = process.env.INJ_LCD ?? 'https://lcd.injective.network';
const KEYFILE = process.env.INJ_KEYFILE ?? '/tmp/inj-mainnet-roundtrip-mnemonic.txt';
const DEST = process.env.INJ_DEST;

if (!DEST || !DEST.startsWith('inj1')) {
  console.error('refusing to sweep: set INJ_DEST to the recipient inj1... address');
  process.exit(1);
}
if (!existsSync(KEYFILE)) {
  console.error(`no keyfile at ${KEYFILE}`);
  process.exit(1);
}

const mnemonic = readFileSync(KEYFILE, 'utf8').trim();
const w = await deriveInjectiveWallet(mnemonic);
console.log('from :', w.address);
console.log('to   :', DEST);

// current balance
const res = await fetch(`${LCD}/cosmos/bank/v1beta1/balances/${w.address}`);
const bal =
  ((await res.json()) as { balances?: { denom: string; amount: string }[] }).balances ?? [];
const inj = bal.find(b => b.denom === 'inj');
if (!inj) {
  console.error('no INJ balance to sweep');
  process.exit(1);
}

// leave a fee, send the rest. fee cap 0.002 INJ (2e15), gas 250k.
const FEE = 2_000_000_000_000_000n;
const balance = BigInt(inj.amount);
const sendAmount = balance - FEE;
if (sendAmount <= 0n) {
  console.error(`balance ${balance} <= fee ${FEE}; nothing to sweep`);
  process.exit(1);
}
console.log(`sweeping ${Number(sendAmount) / 1e18} INJ (leaving ${Number(FEE) / 1e18} for fee)`);

const { sequence } = await queryInjectiveAccount(LCD, w.address);
console.log('sequence:', sequence);

const result = await withdrawToExchange({
  mnemonic,
  restUrl: LCD,
  toAddress: DEST,
  amount: { denom: 'inj', amount: sendAmount.toString() },
  fee: { amount: [{ denom: 'inj', amount: FEE.toString() }], gas: '250000' },
});
console.log('broadcast:', result);
console.log(
  result.code === 0
    ? `SWEPT - ${DEST} received ${Number(sendAmount) / 1e18} INJ (tx ${result.txhash})`
    : `REJECTED (code ${result.code}): ${result.rawLog}`,
);
