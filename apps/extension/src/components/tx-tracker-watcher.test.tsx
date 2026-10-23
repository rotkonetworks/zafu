import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TxOp } from '../tx-ops';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// every open window (popup, side panel) reads the same session storage; here
// each root is one window and `publish` is storage.onChanged reaching them all
const live = vi.hoisted(() => ({
  ops: [] as TxOp[],
  windows: new Set<() => void>(),
  addMessage: (() => undefined) as (m: unknown) => void,
}));
vi.mock('../tx-ops/use-tx-ops', () => ({
  useTxOps: () => {
    const [, tick] = useState(0);
    useEffect(() => {
      const wake = () => tick(n => n + 1);
      live.windows.add(wake);
      return () => void live.windows.delete(wake);
    }, []);
    return live.ops;
  },
}));
vi.mock('../state', () => ({
  useStore: (pick: (s: unknown) => unknown) =>
    pick({ messages: { addMessage: (m: unknown) => live.addMessage(m) } }),
}));
vi.mock('../state/messages', () => ({
  messagesSelector: (s: { messages: unknown }) => s.messages,
}));
vi.mock('@repo/wallet/networks/injective/client', () => ({ queryInjectiveTx: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

import { TxTrackerWatcher } from './tx-tracker-watcher';
import { forgetForm, holdTxOp, readTxOps, writeTxOp } from '../tx-ops';

const settle = () => act(() => new Promise(r => setTimeout(r, 20)));
const publish = async () => {
  live.ops = await readTxOps();
  act(() => live.windows.forEach(wake => wake()));
  await settle();
};

describe('TxTrackerWatcher', () => {
  let roots: { root: Root; el: HTMLElement }[];
  let messages: unknown[];

  beforeEach(async () => {
    await chrome.storage.session.clear();
    live.ops = [];
    messages = [];
    live.addMessage = m => void messages.push(m);
    roots = [1, 2].map(() => {
      const el = document.createElement('div');
      const root = createRoot(el);
      act(() => root.render(createElement(TxTrackerWatcher)));
      return { root, el };
    });
    await settle();
  });

  afterEach(() => roots.forEach(({ root }) => act(() => root.unmount())));

  const toasts = () => roots.filter(({ el }) => el.textContent?.includes('send 1 UM · sent'));
  const send = (opId: string) =>
    writeTxOp(opId, {
      status: 'done',
      network: 'penumbra',
      label: 'send 1 UM',
      txId: 'ab',
      memo: 'thank you',
      recipient: 'penumbra1x',
    });

  it('announces a send once across two open windows', async () => {
    await send('one');
    await publish();
    await publish();
    expect(toasts()).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it('stays quiet while the sending screen shows its own done state', async () => {
    const release = await holdTxOp('shown');
    await send('shown');
    await publish();
    expect(toasts()).toHaveLength(0);
    // the memo is still recorded, once
    expect(messages).toHaveLength(1);
    release();
    await publish();
    expect(toasts()).toHaveLength(0);
  });

  it('a send that did not go through can go again, its form filled as it was', async () => {
    await writeTxOp('failed', {
      status: 'failed',
      network: 'penumbra',
      label: 'send 0.000001 UM',
      error: 'nullifier was already spent',
      memo: 'see you at noon',
      recipient: 'penumbra1x',
      amount: '0.000001',
      asset: 'upenumbra',
    });
    await publish();
    const again = roots
      .flatMap(({ el }) => [...el.querySelectorAll('button')])
      .filter(b => b.textContent === 'try again');
    expect(again).toHaveLength(1);
    act(() => again[0]!.click());
    expect(navigate).toHaveBeenCalledWith('/send', {
      state: {
        network: 'penumbra',
        prefillRecipient: 'penumbra1x',
        prefillMemo: 'see you at noon',
        prefillAmount: '0.000001',
        prefillAsset: 'upenumbra',
      },
    });
  });

  it('forgets the form a minute after, and keeps the record', async () => {
    await writeTxOp('old', {
      status: 'failed',
      network: 'penumbra',
      label: 'send 1 UM',
      notified: true,
      memo: 'secret',
      recipient: 'penumbra1x',
    });
    await forgetForm('old');
    const [op] = await readTxOps();
    expect(op).toMatchObject({ opId: 'old', status: 'failed' });
    expect(op).not.toHaveProperty('memo');
    expect(op).not.toHaveProperty('recipient');
  });
});
