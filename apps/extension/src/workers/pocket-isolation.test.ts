// The zcash worker cannot be stood up under vitest (IndexedDB + the rayon
// wasm + a live endpoint), so this guards the pocket seams in its source: a
// future edit that reintroduces an account-0 path, or signs hot notes with a
// caller-supplied account, fails here instead of in someone's wallet.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// vitest runs from apps/extension
const SRC = readFileSync(resolve(process.cwd(), 'src/workers/zcash-worker.ts'), 'utf8');

/** the `args: [...]` of every prover call to `fn` */
const argsOf = (fn: string): string[] =>
  [...SRC.matchAll(new RegExp(`fn: '${fn}',\\s*args: \\[([^\\]]*)\\]`, 'g'))].map(m => m[1]!);

describe('zcash worker pocket isolation', () => {
  test('every seed-derived scanning key goes through the per-account helper', () => {
    expect(SRC).not.toMatch(/new wasmModule!?\.WalletKeys\(/);
    expect(SRC).toMatch(
      /state\.keys = walletKeysFor\(mnemonic, parsePocketStoreId\(walletId\)\.account\)/,
    );
  });

  test('hot builders sign with the account of the store the notes came from', () => {
    const hot = [
      'build_signed_spend',
      'build_signed_ironwood_send',
      'build_signed_turnstile_migration',
    ];
    let seen = 0;
    for (const fn of hot) {
      for (const args of argsOf(fn)) {
        seen++;
        expect(args, fn).not.toMatch(/Payload\.accountIndex/);
        expect(args, fn).toMatch(/\b(spendAccount|migrateAccount|multiAccount)\b/);
      }
    }
    // send-tx (orchard + ironwood), send-tx-multi, turnstile migration
    expect(seen).toBe(4);
    for (const name of ['spendAccount', 'migrateAccount', 'multiAccount']) {
      expect(SRC).toMatch(new RegExp(`const ${name} = [^;]*hotSpendAccount\\(walletId`));
    }
  });

  test("shielding signs with, and pays into, the store's own pocket", () => {
    expect(SRC).not.toMatch(/derive_transparent_privkey\(\s*mnemonic,\s*0\b/);
    expect(SRC).toMatch(/const shieldAccount = hotSpendAccount\(walletId\)/);
    expect(SRC).toMatch(/walletKeysFor\(mnemonic, shieldAccount\)/);
    expect(SRC).toMatch(/derive_transparent_privkey\(\s*mnemonic,\s*shieldAccount,/);
    // and refuses an input that is not locked to that pocket's key
    expect(SRC).toMatch(/utxos\.every\(u => isP2pkhOf\(u\.script, privkeyHex\)\)/);
  });

  test("deleting a wallet deletes its pockets' stores too", () => {
    expect(SRC).toMatch(/isStoreOfWallet\(storeId, walletId\)/);
  });
});
