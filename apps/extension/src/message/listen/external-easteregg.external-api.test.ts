/**
 * Tests for the external-API hardening on the multisig surface:
 *  - gh #19: same-origin approval-popup dedup (zafu_dkg_join et al.)
 *  - gh #18: zafu_delete_multisig rejects uniformly *after* the capability
 *    gate (no pre-gate label-length oracle) and uses the sanitized label.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { externalMessageListener } from './external-easteregg';
import { grantCapability } from '@repo/storage-chrome/origin';

const validSender = (origin: string): chrome.runtime.MessageSender => ({
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId: 0,
  origin,
  url: `${origin}/index.html`,
});

/** drive the listener and resolve with whatever it passes to sendResponse */
const call = (req: unknown, sender: chrome.runtime.MessageSender): Promise<any> =>
  new Promise(resolve => {
    externalMessageListener(req, sender, resolve);
  });

/** flush microtasks + the pending async handler work */
const flush = () => new Promise(r => setTimeout(r, 0));

let createMock: Mock;

beforeEach(() => {
  // Each test uses a unique origin, so no storage reset is needed — and
  // clearing would wipe the shared mock-chrome storage other test files use.
  (globalThis.chrome.runtime as unknown as { getURL: unknown }).getURL =
    (p: string) => `chrome-extension://test/${p}`;
  createMock = vi.fn(async () => ({ id: Math.floor(Math.random() * 1e6) }));
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    create: createMock,
    onRemoved: { addListener: vi.fn() },
  };
});

describe('gh #19 — same-origin approval-popup dedup', () => {
  it('drops a second dkg_join while one popup is already open for that origin', async () => {
    const origin = 'https://dup.example';
    await grantCapability(origin, 'frost');

    // first request opens a popup and waits for its result (never responds here)
    void call({ type: 'zafu_dkg_join', roomCode: 'r1' }, validSender(origin));
    await flush();
    expect(createMock).toHaveBeenCalledTimes(1);

    // second request from the same origin, popup still open → dropped, no new window
    const second = await call({ type: 'zafu_dkg_join', roomCode: 'r2' }, validSender(origin));
    expect(second).toEqual({ error: 'denied' });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('allows a concurrent popup for a different origin', async () => {
    const a = 'https://a.example';
    const b = 'https://b.example';
    await grantCapability(a, 'frost');
    await grantCapability(b, 'frost');

    void call({ type: 'zafu_dkg_join', roomCode: 'ra' }, validSender(a));
    await flush();
    void call({ type: 'zafu_dkg_join', roomCode: 'rb' }, validSender(b));
    await flush();

    expect(createMock).toHaveBeenCalledTimes(2);
  });
});

describe('gh #18 — zafu_delete_multisig uniform rejection', () => {
  it('rejects a too-short label with the uniform denied shape (granted origin)', async () => {
    const origin = 'https://del-short.example';
    await grantCapability(origin, 'frost');
    const res = await call({ type: 'zafu_delete_multisig', multisigLabel: 'ab' }, validSender(origin));
    expect(res).toEqual({ success: false, error: 'denied' });
  });

  it('does not leak a label-length hint to an ungranted caller (rejects after the gate)', async () => {
    // pre-fix this returned "multisigLabel must be at least 4 chars…" before
    // the capability check; now every path is the uniform gate rejection.
    const res = await call(
      { type: 'zafu_delete_multisig', multisigLabel: 'ab' },
      validSender('https://no-grant.example'),
    );
    expect(res).toEqual({ success: false, error: 'denied' });
  });

  it('rejects a valid label that matches no vault for the caller origin', async () => {
    const origin = 'https://del-nomatch.example';
    await grantCapability(origin, 'frost');
    const res = await call(
      { type: 'zafu_delete_multisig', multisigLabel: 'poker-table' },
      validSender(origin),
    );
    expect(res).toEqual({ success: false, error: 'denied' });
  });
});
