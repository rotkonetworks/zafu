import { describe, expect, test } from 'vitest';
import {
  hotSpendAccount,
  isStoreOfWallet,
  parsePocketStoreId,
  pocketStoreId,
  zcashTransparentIndexKey,
} from './pocket-id';
import { zcashSyncHeightKey } from './keyring/network-worker';
import {
  activeAccountIndex,
  activePocketBirthday,
  activePockets,
  activeZcashStoreId,
  addPocket,
  forgetWallet,
  hiddenPockets,
  hidePocket,
  MAX_POCKETS,
  mergePocketBooks,
  pocketOwner,
  renamePocket,
  sanitizePocketBook,
  selectPocket,
  unhidePocket,
  visiblePockets,
  type PocketBook,
} from './pockets';
import type { AllSlices } from '.';
import type { KeyInfo } from './keyring/types';
import type { ZcashWalletJson } from './wallets';

describe('pocket store ids', () => {
  test('account 0 is the bare wallet id, so existing stores need no migration', () => {
    expect(pocketStoreId('vault-1-abc', 0)).toBe('vault-1-abc');
    expect(parsePocketStoreId('vault-1-abc')).toEqual({ walletId: 'vault-1-abc', account: 0 });
  });

  test('round-trips every account', () => {
    for (const account of [0, 1, 2, 9, 1000, 0x7fffffff]) {
      expect(parsePocketStoreId(pocketStoreId('vault-1-abc', account))).toEqual({
        walletId: 'vault-1-abc',
        account,
      });
    }
  });

  test('distinct accounts never share a store', () => {
    const ids = [0, 1, 2, 10, 11].map(a => pocketStoreId('w', a));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('rejects non zip32 account indices', () => {
    for (const bad of [-1, 1.5, 0x80000000, NaN]) {
      expect(() => pocketStoreId('w', bad)).toThrow(/invalid zip32 account/);
    }
  });

  test('non-canonical ids stay whole, account 0', () => {
    for (const id of ['w#0', 'w#01', 'w#', '#3', 'w#x', 'zcash-1-abc', 'w#99999999999']) {
      expect(parsePocketStoreId(id)).toEqual({ walletId: id, account: 0 });
    }
  });

  test('isStoreOfWallet covers account 0 and pockets, not a lookalike wallet', () => {
    expect(isStoreOfWallet('w', 'w')).toBe(true);
    expect(isStoreOfWallet('w#3', 'w')).toBe(true);
    expect(isStoreOfWallet('w2', 'w')).toBe(false);
    expect(isStoreOfWallet('w2#3', 'w')).toBe(false);
  });

  test('hot spend account comes from the store, and a mismatch is refused', () => {
    expect(hotSpendAccount('w')).toBe(0);
    expect(hotSpendAccount('w#1', 1)).toBe(1);
    // pocket 1 notes signed as pocket 0, and the reverse, are both refused
    expect(() => hotSpendAccount('w#1', 0)).toThrow(/pocket mismatch/);
    expect(() => hotSpendAccount('w', 1)).toThrow(/pocket mismatch/);
  });
});

describe('pocket book', () => {
  test('a fresh wallet has only main, active', () => {
    const book = selectPocket({}, 'z', 0);
    expect(book['z']).toEqual({ pockets: [{ account: 0, name: 'main' }], active: 0 });
  });

  test('add takes the next index, never reuses one, keeps the active pocket', () => {
    let book = addPocket({}, 'z', 'savings', 3_000_000);
    book = addPocket(book, 'z', '  ');
    expect(book['z']!.pockets).toEqual([
      { account: 0, name: 'main' },
      { account: 1, name: 'savings', birthday: 3_000_000 },
      { account: 2, name: 'pocket 2' },
    ]);
    expect(book['z']!.active).toBe(0);
  });

  test('add stops at the cap', () => {
    let book: PocketBook = {};
    for (let i = 1; i < MAX_POCKETS; i++) {
      book = addPocket(book, 'z', `p${i}`);
    }
    expect(() => addPocket(book, 'z', 'one too many')).toThrow(/at most/);
  });

  test('rename trims, ignores blanks and unknown pockets', () => {
    const book = addPocket({}, 'z', 'a');
    expect(renamePocket(book, 'z', 1, ' b ')['z']!.pockets[1]!.name).toBe('b');
    expect(renamePocket(book, 'z', 1, '  ')).toBe(book);
    expect(renamePocket(book, 'z', 7, 'x')).toBe(book);
  });

  test('select only picks an existing pocket', () => {
    const book = addPocket({}, 'z', 'a');
    expect(selectPocket(book, 'z', 1)['z']!.active).toBe(1);
    expect(selectPocket(book, 'z', 5)).toBe(book);
  });

  test('forgetWallet removes only that wallet', () => {
    const book = addPocket(addPocket({}, 'z', 'a'), 'y', 'b');
    expect(Object.keys(forgetWallet(book, 'z'))).toEqual(['y']);
  });

  test('sanitize drops bad rows, duplicates and dangling active', () => {
    const raw = {
      z: {
        pockets: [
          { account: 1, name: 'a' },
          { account: 1, name: 'dup' },
          { account: -1, name: 'neg' },
          { account: 2, name: 7 },
          { account: 3, name: 'bad birthday', birthday: -5 },
        ],
        active: 9,
      },
      junk: null,
    };
    expect(sanitizePocketBook(raw)).toEqual({
      z: {
        pockets: [
          { account: 0, name: 'main' },
          { account: 1, name: 'a' },
        ],
        active: 0,
      },
      junk: { pockets: [{ account: 0, name: 'main' }], active: 0 },
    });
    expect(sanitizePocketBook('nope')).toEqual({});
  });
});

describe('hide and unhide', () => {
  test('main can never be hidden', () => {
    const book = addPocket({}, 'z', 'savings');
    expect(hidePocket(book, 'z', 0)).toBe(book);
  });

  test('hiding an unknown pocket is a no-op', () => {
    const book = addPocket({}, 'z', 'savings');
    expect(hidePocket(book, 'z', 7)).toBe(book);
  });

  test('hide marks the pocket, unhide clears it; both keep the pocket (never delete)', () => {
    let book = addPocket({}, 'z', 'savings');
    book = hidePocket(book, 'z', 1);
    expect(visiblePockets(book['z']!.pockets)).toEqual([{ account: 0, name: 'main' }]);
    expect(hiddenPockets(book['z']!.pockets)).toEqual([
      { account: 1, name: 'savings', hidden: true },
    ]);
    book = unhidePocket(book, 'z', 1);
    expect(book['z']!.pockets).toEqual([
      { account: 0, name: 'main' },
      { account: 1, name: 'savings' },
    ]);
  });

  test('hiding the active pocket switches the active one to main, the calmer option', () => {
    let book = selectPocket(addPocket({}, 'z', 'savings'), 'z', 1);
    expect(book['z']!.active).toBe(1);
    book = hidePocket(book, 'z', 1);
    expect(book['z']!.active).toBe(0);
    expect(book['z']!.pockets.find(p => p.account === 1)?.hidden).toBe(true);
  });

  test('hiding a pocket that is not active leaves the active one untouched', () => {
    let book = addPocket(addPocket({}, 'z', 'savings'), 'z', 'rent');
    book = selectPocket(book, 'z', 1);
    book = hidePocket(book, 'z', 2);
    expect(book['z']!.active).toBe(1);
  });

  test('sanitize strips a hidden flag that somehow landed on main', () => {
    const raw = { z: { pockets: [{ account: 0, name: 'main', hidden: true }], active: 0 } };
    expect(sanitizePocketBook(raw)['z']!.pockets).toEqual([{ account: 0, name: 'main' }]);
  });

  test('sanitize refuses to leave a crafted backup pointed at a hidden pocket', () => {
    const raw = {
      z: {
        pockets: [
          { account: 0, name: 'main' },
          { account: 1, name: 'savings', hidden: true },
        ],
        active: 1,
      },
    };
    expect(sanitizePocketBook(raw)['z']!.active).toBe(0);
  });
});

describe('pocket backup restore', () => {
  const local = selectPocket(addPocket({}, 'z', 'local name'), 'z', 1);
  const backup = sanitizePocketBook({
    z: {
      pockets: [
        { account: 0, name: 'main' },
        { account: 1, name: 'backup name' },
        { account: 2, name: 'only in backup', birthday: 2_900_000 },
      ],
      active: 2,
    },
    other: {
      pockets: [
        { account: 0, name: 'main' },
        { account: 4, name: 'x' },
      ],
      active: 4,
    },
  });

  test('merge adds pockets, keeps local names and selection', () => {
    const out = mergePocketBooks(local, backup, 'merge');
    expect(out['z']!.pockets.map(p => p.name)).toEqual(['main', 'local name', 'only in backup']);
    expect(out['z']!.active).toBe(1);
    expect(out['other']!.active).toBe(4);
  });

  test('replace lets backup names win but never drops a local pocket', () => {
    const extra = addPocket(local, 'z', 'local only');
    const out = mergePocketBooks(extra, backup, 'replace');
    expect(out['z']!.pockets.map(p => [p.account, p.name])).toEqual([
      [0, 'main'],
      [1, 'backup name'],
      [2, 'only in backup'],
    ]);
    // account 2 existed locally as 'local only' and in the backup; the index
    // is kept and never renumbered
    expect(out['z']!.active).toBe(2);
  });

  test('a backup made before pockets restores nothing', () => {
    expect(mergePocketBooks(local, sanitizePocketBook(undefined), 'replace')).toEqual(local);
  });

  test('a hidden pocket round-trips through a backup: name and hidden both survive', () => {
    // exportPersonalData (contacts.ts) ships pockets.book as-is, so the
    // round trip here is exactly what a backup file carries and restores.
    const before = hidePocket(addPocket({}, 'z', 'savings'), 'z', 1);
    const exported = JSON.parse(JSON.stringify(before)) as unknown;
    const restored = mergePocketBooks({}, sanitizePocketBook(exported), 'replace');
    const pocket = restored['z']!.pockets.find(p => p.account === 1);
    expect(pocket?.name).toBe('savings');
    expect(pocket?.hidden).toBe(true);
    // still hidden from a list, still in the book - never deleted
    expect(visiblePockets(restored['z']!.pockets)).toEqual([{ account: 0, name: 'main' }]);
  });
});

const keyInfo = (over: Partial<KeyInfo>): KeyInfo => ({
  id: 'vault-1',
  name: 'w',
  type: 'mnemonic',
  isSelected: true,
  createdAt: 0,
  insensitive: {},
  ...over,
});

const zcashWallet = (over: Partial<ZcashWalletJson>): ZcashWalletJson => ({
  id: 'zcash-1',
  label: 'w',
  orchardFvk: 'uview1x',
  address: '',
  accountIndex: 0,
  mainnet: true,
  vaultId: 'vault-2',
  ...over,
});

const stateWith = (
  key: KeyInfo | undefined,
  book: PocketBook,
  zcashWallets: ZcashWalletJson[] = [],
): AllSlices =>
  ({
    keyRing: { keyInfos: key ? [key] : [], selectedKeyInfo: key, activeNetwork: 'zcash' },
    wallets: { zcashWallets, activeZcashIndex: 0 },
    pockets: { book },
  }) as unknown as AllSlices;

describe('pocket selectors', () => {
  const hot = keyInfo({ insensitive: { zid: 'zid-abc' } });

  test('pockets are filed under the zid, which survives a reinstall', () => {
    expect(pocketOwner(hot)).toBe('zid-abc');
    expect(pocketOwner(keyInfo({}))).toBe('vault-1');
  });

  test('hot wallet with no pockets behaves exactly as today: account 0, bare store', () => {
    const s = stateWith(hot, {});
    expect(activeAccountIndex(s)).toBe(0);
    expect(activeZcashStoreId(s)).toBe('vault-1');
    expect(activePocketBirthday(s)).toBeUndefined();
    expect(activePockets(s)).toEqual([{ account: 0, name: 'main' }]);
  });

  test('hot wallet follows the active pocket', () => {
    const book = selectPocket(addPocket({}, 'zid-abc', 'savings', 3_100_000), 'zid-abc', 1);
    const s = stateWith(hot, book);
    expect(activeAccountIndex(s)).toBe(1);
    expect(activeZcashStoreId(s)).toBe('vault-1#1');
    expect(activePocketBirthday(s)).toBe(3_100_000);
  });

  test('switching pockets changes what the home balance hook and the send builder read', () => {
    // these two selectors are exactly what routes/popup/home/zcash-home.tsx and
    // routes/popup/send pass to getBalanceInWorker / usePoolBalances /
    // buildSendTxInWorker - this pins that a pocket switch actually changes the
    // worker store and the zip32 account those calls build against.
    const readSiteInputs = (s: AllSlices) => ({
      storeId: activeZcashStoreId(s),
      account: activeAccountIndex(s),
    });

    let book = addPocket({}, 'zid-abc', 'savings', 3_100_000);
    expect(readSiteInputs(stateWith(hot, book))).toEqual({ storeId: 'vault-1', account: 0 });

    book = selectPocket(book, 'zid-abc', 1);
    expect(readSiteInputs(stateWith(hot, book))).toEqual({ storeId: 'vault-1#1', account: 1 });

    // switching back restores the original store and account - a pocket
    // switch is a pure selection, not a one-way migration.
    book = selectPocket(book, 'zid-abc', 0);
    expect(readSiteInputs(stateWith(hot, book))).toEqual({ storeId: 'vault-1', account: 0 });
  });

  test('viewing-key and zigner wallets use the key account and never split their store', () => {
    // a pocket book entry under their id must not leak into them
    const book = selectPocket(addPocket({}, 'vault-2', 'x'), 'vault-2', 1);
    for (const type of ['zigner-zafu', 'frost-multisig'] as const) {
      const cold = keyInfo({ id: 'vault-2', type, insensitive: { supportedNetworks: ['zcash'] } });
      const s = stateWith(cold, book, [zcashWallet({ accountIndex: 3 })]);
      expect(activeAccountIndex(s)).toBe(3);
      expect(activeZcashStoreId(s)).toBe('vault-2');
      expect(activePockets(s)).toEqual([]);
      expect(activePocketBirthday(s)).toBeUndefined();
    }
  });

  test('no wallet at all', () => {
    const s = stateWith(undefined, {});
    expect(activeAccountIndex(s)).toBe(0);
    expect(activeZcashStoreId(s)).toBeUndefined();
  });
});

describe('existing wallets are untouched (account 0 migration)', () => {
  const hot = keyInfo({ insensitive: { zid: 'zid-abc' } });

  test('a profile saved before pockets hydrates to the same wallet', () => {
    // no zcashPockets key in storage at all
    const book = sanitizePocketBook(undefined);
    const s = stateWith(hot, book);
    expect(activeZcashStoreId(s)).toBe(hot.id);
    expect(activeAccountIndex(s)).toBe(0);
  });

  test('every per-wallet storage key keeps its historic name for account 0', () => {
    const store = pocketStoreId(hot.id, 0);
    // worker IndexedDB rows (notes, spent, witnesses, meta, sent) are keyed by
    // this id, so the same rows load: same notes, same balance
    expect(store).toBe(hot.id);
    expect(zcashSyncHeightKey(store)).toBe(zcashSyncHeightKey(hot.id));
    expect(`zcashTAddrs:${store}`).toBe(`zcashTAddrs:${hot.id}`);
    expect(zcashTransparentIndexKey(0)).toBe('zcashTransparentIndex');
  });

  test('pockets get fresh keys that never collide with account 0', () => {
    expect(zcashTransparentIndexKey(1)).toBe('zcashTransparentIndex#1');
    expect(zcashSyncHeightKey(pocketStoreId(hot.id, 1))).not.toBe(zcashSyncHeightKey(hot.id));
  });
});
