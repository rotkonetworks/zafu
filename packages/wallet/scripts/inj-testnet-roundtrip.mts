/**
 * #34 testnet round-trip - the one gate that needs a funded key.
 *
 * Run 1: prints a fresh inj address (persisted to a temp file). Fund it with
 * testnet INJ at https://testnet.faucet.injective.network/ (one captcha).
 * Run 2: signs a self-send with our eth_secp256k1 signer and broadcasts to the
 * live Injective testnet. code === 0 means a real node ACCEPTED the signature -
 * the gate passes and the Injective ramp can be enabled.
 *
 *   cd packages/wallet && npx tsx scripts/inj-testnet-roundtrip.mts
 */
import { generateMnemonic } from 'bip39';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deriveInjectiveWallet } from '../src/networks/injective/derive';
import { queryInjectiveAccount } from '../src/networks/injective/client';
import { withdrawToExchange } from '../src/networks/injective/conduit';

const LCD = process.env.INJ_LCD ?? 'https://testnet.sentry.lcd.injective.network';
const KEYFILE = process.env.INJ_KEYFILE ?? '/tmp/inj-testnet-mnemonic.txt';

const mnemonic = existsSync(KEYFILE)
  ? readFileSync(KEYFILE, 'utf8').trim()
  : (() => {
      const m = generateMnemonic();
      writeFileSync(KEYFILE, m, { mode: 0o600 });
      return m;
    })();

const w = await deriveInjectiveWallet(mnemonic);
console.log('inj address :', w.address);
console.log('testnet LCD :', LCD);

try {
  const acct = await queryInjectiveAccount(LCD, w.address);
  console.log('account     :', acct);
  console.log('signing + broadcasting a self-send (proves eth_secp256k1 is accepted)...');
  const res = await withdrawToExchange({
    mnemonic,
    restUrl: LCD,
    toAddress: w.address, // self-send; only the signature acceptance matters
    amount: { denom: 'inj', amount: '1000000000000000' }, // 0.001 INJ (18 dec)
    fee: { amount: [{ denom: 'inj', amount: '2000000000000000' }], gas: '250000' },
  });
  console.log('broadcast   :', res);
  console.log(
    res.code === 0
      ? '\nGATE PASSED - a live Injective node accepted the eth_secp256k1 signature.'
      : `\nREJECTED (code ${res.code}): ${res.rawLog}`,
  );
} catch (e) {
  console.log(`\nnot funded yet: ${e instanceof Error ? e.message : String(e)}`);
  console.log(`fund the address above at https://testnet.faucet.injective.network/ then re-run.`);
}
