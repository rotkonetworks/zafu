import { vi } from 'vitest';

export const id = 'test-extension-id';
// Real chrome.runtime.sendMessage returns a Promise when called without a
// callback (MV3); defaulting to that here instead of `undefined` lets code
// that does `sendMessage(...).catch(...)` - the normal way to avoid an
// "Unchecked runtime.lastError" - run under test without every call site
// needing its own mock.
export const sendMessage = vi.fn(() => Promise.resolve(undefined));
export const connect = vi.fn(() => ({
  onMessage: { addListener: vi.fn() },
  onDisconnect: { addListener: vi.fn() },
}));
