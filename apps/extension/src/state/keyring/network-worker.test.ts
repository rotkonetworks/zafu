/**
 * A window's mirror of the offscreen-hosted zcash worker must never outlive
 * the host. Chrome can close or crash the offscreen document; the one that
 * comes back has no worker, and a window still believing "syncing" used to
 * skip every start and wait on calls nobody would answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (
  msg: { type?: string; network?: string; msg?: unknown },
  sender: chrome.runtime.MessageSender,
) => unknown;

/** the offscreen document, as a window sees it: the extension's own origin */
const HOST: chrome.runtime.MessageSender = {
  id: 'ext',
  origin: 'chrome-extension://ext',
  url: 'chrome-extension://ext/offscreen.html',
};

/** a fake runtime bus with one offscreen host whose worker can disappear */
const fakeHost = () => {
  const listeners: Listener[] = [];
  const host = { hasWorker: true, syncing: ['w1'] };
  const emit = (msg: unknown) =>
    listeners.forEach(l => l({ type: 'NW_EVENT', network: 'zcash', msg }, HOST));
  const sendMessage = vi.fn(async (m: { type: string; message?: { type: string; id: string } }) => {
    switch (m.type) {
      case 'ZCASH_ENSURE_OFFSCREEN':
        return { ok: true };
      case 'NW_SPAWN':
        host.hasWorker = true;
        queueMicrotask(() => emit({ type: 'ready' }));
        return { ok: true };
      case 'NW_CALL': {
        if (!host.hasWorker) {
          return { ok: false };
        }
        const { type, id } = m.message!;
        queueMicrotask(() =>
          emit({
            type: type === 'stop-sync' ? 'sync-stopped' : 'sync-started',
            id,
            walletId: 'w1',
          }),
        );
        return { ok: true };
      }
      case 'NW_PING':
        return { ok: host.hasWorker, syncing: host.syncing };
      default:
        return undefined;
    }
  });
  return { host, listeners, sendMessage };
};

let bus: ReturnType<typeof fakeHost>;
let lost: string[];
const onLost = (e: Event) => lost.push((e as CustomEvent).detail.network);

beforeEach(() => {
  vi.resetModules();
  bus = fakeHost();
  lost = [];
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'ext',
      sendMessage: bus.sendMessage,
      onMessage: { addListener: (l: Listener) => bus.listeners.push(l) },
    },
  });
  window.addEventListener('network-sync-lost', onLost);
});

afterEach(() => {
  window.removeEventListener('network-sync-lost', onLost);
  vi.useRealTimers();
});

const startSyncing = async () => {
  const nw = await import('./network-worker');
  await nw.spawnNetworkWorker('zcash');
  await nw.startWatchOnlySyncInWorker('zcash', 'w1', 'uview1', 'https://node', 3_000_000);
  expect(nw.isWalletSyncing('zcash', 'w1')).toBe(true);
  return nw;
};

describe('a window outliving the offscreen host', () => {
  it('a call the new host cannot take fails at once and drops the stale mirror', async () => {
    const nw = await startSyncing();
    bus.host.hasWorker = false;
    await expect(nw.stopSyncInWorker('zcash', 'w1')).rejects.toThrow(/went away/);
    expect(nw.isWalletSyncing('zcash', 'w1')).toBe(false);
    expect(lost).toEqual(['zcash']);
  });

  it('a quiet window asks the host, and a host without the worker restarts sync', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    const nw = await startSyncing();
    bus.host.hasWorker = false;
    await vi.advanceTimersByTimeAsync(46_000);
    expect(bus.sendMessage.mock.calls.some(([m]) => m.type === 'NW_PING')).toBe(true);
    expect(nw.isWalletSyncing('zcash', 'w1')).toBe(false);
    expect(lost).toEqual(['zcash']);
  });

  it('a host that stopped the wallet without telling this window restarts it here', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    const nw = await startSyncing();
    bus.host.syncing = [];
    await vi.advanceTimersByTimeAsync(46_000);
    expect(nw.isWalletSyncing('zcash', 'w1')).toBe(false);
    expect(lost).toEqual(['zcash']);
  });

  it('a window that keeps hearing from the host never asks', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    await startSyncing();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      bus.listeners.forEach(l =>
        l(
          {
            type: 'NW_EVENT',
            network: 'zcash',
            msg: { type: 'sync-progress', walletId: 'w1', payload: {} },
          },
          HOST,
        ),
      );
    }
    expect(bus.sendMessage.mock.calls.some(([m]) => m.type === 'NW_PING')).toBe(false);
    expect(lost).toEqual([]);
  });
});
