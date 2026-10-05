import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '../state';
import { LpCard } from '../components/lp-card';
import { advance, needs, resumed, sending, sent, startFlight } from './flight';
import { ADD_MEMO } from './math';
import { changeLp, exportLp, patchLpPocket, readLp, readLpPocket, restoreLp } from './store';

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
