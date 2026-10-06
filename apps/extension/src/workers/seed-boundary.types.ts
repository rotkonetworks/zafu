// Type-level half of seed-boundary.test.ts, checked by tsc (test files are
// not): no zcash spend or sync call takes a recovery phrase. Never imported.
import type * as Nw from '../state/keyring/network-worker';

declare const nw: typeof Nw;

export const phraseIsNotAVault = () => [
  // @ts-expect-error a phrase is not a VaultUnlock
  nw.buildSendTxInWorker('zcash', 'w', 'url', 'u1', '1', '', 0, true, 'a phrase'),
  // @ts-expect-error a phrase is not a VaultUnlock
  nw.buildMultiSendTxInWorker('zcash', 'w', 'url', [], 0, true, 'a phrase'),
  nw.buildTurnstileMigrationInWorker(
    'zcash',
    'w',
    'url',
    0,
    true,
    undefined,
    'zidecar',
    // @ts-expect-error a phrase is not a VaultUnlock
    'a phrase',
  ),
  // @ts-expect-error a phrase is not a VaultUnlock
  nw.shieldInWorker('zcash', 'w', 'a phrase', 'url', [], true),
  // @ts-expect-error a phrase is not a VaultUnlock
  nw.startSyncInWorker('zcash', 'w', 'a phrase', 'url'),
  // @ts-expect-error a phrase is not a VaultUnlock
  nw.deriveAddressInWorker('zcash', 'a phrase', 0),
  // @ts-expect-error a phrase is not a VaultUnlock
  nw.thorAddressInWorker({ source: 'seed', vault: 'a phrase' }, 1),
  // @ts-expect-error a raw key is not a VaultUnlock
  nw.thorAddressInWorker({ source: 'random', vault: 'ab'.repeat(32) }, 1),
  nw.signThorDepositInWorker(
    // @ts-expect-error a phrase is not a VaultUnlock
    { source: 'seed', vault: 'a phrase' },
    {
      index: 1,
      expected: 'thor1',
      rune: '0',
      memo: '-:ZEC.ZEC:10000',
      accountNumber: '1',
      sequence: '0',
    },
  ),
];
