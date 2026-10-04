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
];
