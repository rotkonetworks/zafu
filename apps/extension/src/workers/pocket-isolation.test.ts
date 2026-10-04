// The zcash worker cannot be stood up under vitest (IndexedDB + the rayon
// wasm + a live endpoint), so this guards the pocket seams in its source: a
// future edit that reintroduces an account-0 path, or signs hot notes with a
// caller-supplied account, fails here instead of in someone's wallet.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// vitest runs from apps/extension
const SRC = readFileSync(resolve(process.cwd(), 'src/workers/zcash-worker.ts'), 'utf8');

/** the account argument of every hot signing scope */
const signingAccounts = (): string[] =>
  [...SRC.matchAll(/withSpendKeys\(\s*wasmModule\.SpendKeys,\s*[\w.]+,\s*([\w.]+),/g)].map(
    m => m[1]!,
  );

describe('zcash worker pocket isolation', () => {
  test('every seed-derived scanning key goes through the per-account helper', () => {
    expect(SRC).not.toMatch(/new wasmModule!?\.WalletKeys\(/);
    expect(SRC).toMatch(
      /state\.keys = walletKeysFor\(mnemonic, parsePocketStoreId\(walletId\)\.account\)/,
    );
  });

  test('hot builds sign with the account of the store the notes came from', () => {
    // send-tx (ironwood + orchard), turnstile migration, send-tx-multi, shield
    expect(signingAccounts()).toEqual([
      'spendAccount',
      'spendAccount',
      'migrateAccount',
      'multiAccount',
      'shieldAccount',
    ]);
    for (const name of ['spendAccount', 'migrateAccount', 'multiAccount', 'shieldAccount']) {
      expect(SRC).toMatch(new RegExp(`const ${name} = [^;]*hotSpendAccount\\(walletId`));
    }
  });

  test("shielding signs with, and pays into, the store's own pocket", () => {
    expect(SRC).toMatch(/const shieldAccount = hotSpendAccount\(walletId\)/);
    expect(SRC).toMatch(/fixOrchardAddress\(keys\.receiving_address\(\), mainnet\)/);
    expect(SRC).toMatch(/const pubkeyHex = keys\.transparent_pubkey\(addrIndex\)/);
    // and refuses an input that is not locked to that pocket's key
    expect(SRC).toMatch(/utxos\.every\(u => isP2pkhOf\(u\.script, pubkeyHex\)\)/);
  });

  test("deleting a wallet deletes its pockets' stores too", () => {
    expect(SRC).toMatch(/isStoreOfWallet\(storeId, walletId\)/);
  });
});
