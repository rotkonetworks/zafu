import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '../state';
import { LpCard } from '../components/lp-card';
import { drive, type DriveDeps } from './drive';
import {
  advance,
  cancelFlight,
  cancellable,
  needs,
  resumed,
  sending,
  sent,
  StaleFlight,
  startFlight,
} from './flight';
import { ADD_MEMO } from './math';
import {
  beginFlight,
  changeFlight,
  changeLp,
  exportLp,
  exportLpRune,
  optInRune,
  optOutRune,
  patchLpPocket,
  readLp,
  readLpPocket,
  restoreLp,
  restoreLpRune,
  RUNE_COUNTER,
  saveFlight,
} from './store';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const LP = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** mount, wait for the sealed read to land (or `ms` to pass), and hand back the text */
const mount = async (node: React.ReactNode, ms = 3000): Promise<string> => {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => root.render(node));
  for (let t = 0; t < ms && !el.textContent; t += 100) {
    await act(() => new Promise(r => setTimeout(r, 100)));
  }
  const text = el.textContent ?? '';
  act(() => root.unmount());
  el.remove();
  return text;
};

beforeEach(async () => {
  localMock.clear();
  sessionMock.clear();
  const useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
});

describe('the lp book, sealed', () => {
  test('never in the clear, and read back per pocket', async () => {
    await changeLp(() => ({ 'vault#1': { index: 21, address: LP } }));
    const raw = JSON.stringify(localMock.get('zecLp'));
    expect(raw).toContain('encrypted');
    expect(raw).not.toContain('t1PTs8');
    expect(await readLpPocket('vault#1')).toEqual({ index: 21, address: LP });
  });

  test('a locked wallet reads nothing and writes nothing', async () => {
    await changeLp(() => ({ v: { index: 3, address: LP } }));
    sessionMock.clear();
    expect(await readLp()).toEqual({});
    expect(await patchLpPocket('v', { address: 'x' })).toBe(false);
  });

  test('a damaged flight is dropped, never the index', async () => {
    await changeLp(() => ({
      v: { index: 5, address: LP, flight: { v: 9 } as never, cache: { zat: 1 } as never },
    }));
    expect(await readLpPocket('v')).toEqual({ index: 5, address: LP });
  });

  test('a box that will not open reads as nothing, and is not overwritten by a read', async () => {
    localMock.set('zecLp', { encrypted: 'not-a-real-box' });
    expect(await readLp()).toEqual({});
    expect(localMock.get('zecLp')).toEqual({ encrypted: 'not-a-real-box' });
  });
});

describe('a flight survives the tab closing', () => {
  test('saved mid-way, read back, it carries on from its stage', async () => {
    let f = startFlight('add', 1_000_000n, ADD_MEMO, { unitsBefore: '0' });
    f = advance(sent(sending(f), 'fund-txid'), { short: 0n });
    await changeLp(() => ({ v: { index: 21, address: LP, flight: f } }));
    // the tab closes; a new one opens and reads it
    const back = resumed((await readLpPocket('v'))!.flight!);
    expect(back.stage).toBe('send');
    expect(needs(back)).toBe('send');
  });

  test('a send that was out when the tab closed is never sent again by itself', async () => {
    const f = sending(advance(sent(sending(startFlight('add', 1n, ADD_MEMO)), 'x'), { short: 0n }));
    await changeLp(() => ({ v: { index: 21, address: LP, flight: f } }));
    const back = resumed((await readLpPocket('v'))!.flight!);
    expect(needs(back)).toBeUndefined();
    expect(back.error).toMatch(/may already have gone out/);
  });
});

describe('the backup', () => {
  test("carries each pocket's lp index by owner key, and a restore raises the scan counter", async () => {
    await changeLp(() => ({
      'vault-a': { index: 21, address: LP },
      'vault-a#2': { index: 4, address: 't1other' },
      'vault-gone': { index: 9 },
    }));
    const backup = await exportLp(id => (id === 'vault-a' ? 'zid-a' : undefined));
    expect(backup).toEqual({ 'zid-a': { '0': 21, '2': 4 } });

    localMock.delete('zecLp');
    localMock.set('zcashTransparentIndex', 3);
    await restoreLp(backup, owner => (owner === 'zid-a' ? 'vault-new' : undefined));
    expect(await readLp()).toEqual({ 'vault-new': { index: 21 }, 'vault-new#2': { index: 4 } });
    expect(localMock.get('zcashTransparentIndex')).toBe(21);
    expect(localMock.get('zcashTransparentIndex#2')).toBe(4);
  });

  test('a pocket that already has an lp address keeps it', async () => {
    await changeLp(() => ({ 'vault-new': { index: 30, address: LP } }));
    await restoreLp({ 'zid-a': { '0': 21 } }, () => 'vault-new');
    expect((await readLpPocket('vault-new'))?.index).toBe(30);
  });

  test('junk in the backup restores nothing', async () => {
    await restoreLp({ 'zid-a': { '0': -1, x: 'y' } }, () => 'v');
    await restoreLp('junk', () => 'v');
    await restoreLp(undefined, () => 'v');
    expect(await readLp()).toEqual({});
  });
});

describe('the home card', () => {
  test('shows the last read with its age, and asks the network nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await changeLp(() => ({
      v: {
        index: 21,
        address: LP,
        cache: { zat: '964000', sharePct: 1.37, readAt: Date.now() - 2 * 3_600_000 },
      },
    }));
    const text = await mount(<LpCard storeId='v' />);
    expect(text).toContain('zec liquidity');
    expect(text).toMatch(/read 2 h ago/);
    expect(text).toContain('1.37% of the pool');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('is absent with nothing read and nothing on its way', async () => {
    await changeLp(() => ({ v: { index: 21, address: LP } }));
    expect(await mount(<LpCard storeId='v' />, 1000)).toBe('');
  });
});

describe('one writer at a time, in storage', () => {
  const ID = 'vault#1';
  const TEX = 'tex1h55z0mdpnaxjxqs39sht9659ztnjk32reer52v';

  test('a write from an older copy is refused; after a broadcast it lands', async () => {
    await changeLp(() => ({ [ID]: { index: 21, address: LP } }));
    const f = (await beginFlight(ID, startFlight('add', 1_000_000n, ADD_MEMO)))!;
    const newer = await saveFlight(ID, { ...f, fundZat: '1' });
    await expect(saveFlight(ID, { ...f, fundZat: '2' })).rejects.toBeInstanceOf(StaleFlight);
    expect((await readLpPocket(ID))?.flight?.fundZat).toBe('1');
    const done = await saveFlight(ID, { ...f, fundTxid: 'tx' }, true);
    expect(done.rev).toBe((newer.rev ?? 0) + 1);
  });

  test('a second flight never starts while one is on its way', async () => {
    await changeLp(() => ({ [ID]: { index: 21, address: LP } }));
    expect(await beginFlight(ID, startFlight('add', 1n, ADD_MEMO, {}, 1))).toBeDefined();
    expect(await beginFlight(ID, startFlight('add', 2n, ADD_MEMO, {}, 2))).toBeUndefined();
    expect((await readLpPocket(ID))?.flight?.amountZat).toBe('1');
  });

  test('a cancel written mid-turn wins: the turn stops before the deposit', async () => {
    await changeLp(() => ({ [ID]: { index: 21, address: LP } }));
    const started = (await beginFlight(ID, startFlight('add', 1_000_000n, ADD_MEMO)))!;
    const settled = await saveFlight(ID, sent(sending(started), 'fund-txid'));
    let answer!: (v: { fee: string; change: string; short: string }) => void;
    const deposit = vi.fn(async () => 'send-txid');
    const d: DriveDeps = {
      owner: ID,
      address: LP,
      index: 21,
      vault: async () => ({
        inbound: { address: TEX, halted: false, lpPaused: false, dust: 15_000n, outboundFee: 1n },
      }),
      plan: () => new Promise(r => (answer = r)),
      shieldOut: async () => 'x',
      deposit,
      shieldBack: async () => 'shield-txid',
      seen: async () => ({ observed: false, finalised: false }),
      units: async () => 0n,
      utxoZat: async () => [],
      save: (f, after) => saveFlight(ID, f, after),
    };
    // the tick's turn waits inside observe on the lp address plan
    const turn = drive(settled, d, TEX, true);
    await new Promise(r => setTimeout(r, 0));
    // the person cancels: decided on the stored flight, under the lock
    const next = await changeFlight(ID, f => (f && cancellable(f) ? cancelFlight(f) : false));
    expect(next?.cancelled).toBe(true);
    answer({ fee: '15000', change: '0', short: '0' });
    await expect(turn).rejects.toBeInstanceOf(StaleFlight);
    expect(deposit).not.toHaveBeenCalled();
    const stored = (await readLpPocket(ID))?.flight;
    expect(stored?.cancelled).toBe(true);
    expect(stored?.stage).toBe('shield');
  });
});

describe('the rune opt-in', () => {
  test('none until chosen: no record, no counter, nothing for the backup', async () => {
    await changeLp(() => ({ 'vault-a': { index: 21, address: LP } }));
    expect((await readLpPocket('vault-a'))?.rune).toBeUndefined();
    expect(await exportLpRune(() => 'zid-a')).toBeUndefined();
    expect(localMock.get('cosmosChainCounters')).toBeUndefined();
  });

  test('chosen: an index from its own counter, sealed with the book; off keeps the index', async () => {
    await changeLp(() => ({ 'vault-a': { index: 21, address: LP } }));
    const r = await optInRune('vault-a');
    expect(r).toEqual({ index: 1, on: true, address: undefined });
    expect(localMock.get('cosmosChainCounters')).toEqual({ [RUNE_COUNTER]: 1 });
    await patchLpPocket('vault-a', { rune: { ...r!, address: 'thor1abc' } });
    expect(JSON.stringify(localMock.get('zecLp'))).not.toContain('thor1abc');
    await optOutRune('vault-a');
    expect((await readLpPocket('vault-a'))?.rune).toEqual({ index: 1, on: false });
    // a later opt-in brings back the same index, not a new one
    expect((await optInRune('vault-a'))?.index).toBe(1);
    expect(localMock.get('cosmosChainCounters')).toEqual({ [RUNE_COUNTER]: 1 });
  });

  test('a pocket without an lp record cannot opt in', async () => {
    expect(await optInRune('vault-none')).toBeUndefined();
  });

  test('the backup carries only { index, on } (never an address), and a restore raises the counter', async () => {
    await changeLp(() => ({
      'vault-a': { index: 21, address: LP, rune: { index: 7, on: true, address: 'thor1abc' } },
      'vault-a#2': { index: 4, address: 't1other' },
    }));
    const backup = await exportLpRune(id => (id === 'vault-a' ? 'zid-a' : undefined));
    expect(backup).toEqual({ 'zid-a': { '0': { index: 7, on: true } } });
    expect(JSON.stringify(backup)).not.toContain('thor1');

    localMock.delete('zecLp');
    await restoreLp({ 'zid-a': { '0': 21 } }, () => 'vault-new');
    await restoreLpRune(backup, owner => (owner === 'zid-a' ? 'vault-new' : undefined));
    expect((await readLpPocket('vault-new'))?.rune).toEqual({ index: 7, on: true });
    expect(localMock.get('cosmosChainCounters')).toEqual({ [RUNE_COUNTER]: 7 });
    // the next opt-in elsewhere never reuses 7
    await changeLp(b => ({ ...b, 'vault-new#3': { index: 9 } }));
    expect((await optInRune('vault-new#3'))?.index).toBe(8);
  });

  test('junk rune backups restore nothing', async () => {
    await changeLp(() => ({ v: { index: 2 } }));
    await restoreLpRune({ z: { '0': { index: -1, on: true }, '1': 'x' } }, () => 'v');
    await restoreLpRune('junk', () => 'v');
    expect((await readLpPocket('v'))?.rune).toBeUndefined();
  });
});
