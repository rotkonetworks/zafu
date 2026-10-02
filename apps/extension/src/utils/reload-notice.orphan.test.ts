import { afterEach, describe, expect, it, vi } from 'vitest';
import { isContextInvalidated, runtimeGone } from './reload-notice';

const realChrome = globalThis.chrome;
afterEach(() => {
  globalThis.chrome = realChrome;
});

describe('runtimeGone', () => {
  it('is true when an orphaned script has no chrome.runtime', () => {
    vi.stubGlobal('chrome', {});
    expect(runtimeGone()).toBe(true);
    expect(
      isContextInvalidated(
        new TypeError("Cannot read properties of undefined (reading 'sendMessage')"),
      ),
    ).toBe(true);
  });
  it("is true for the 'invalid' id older chrome reports", () => {
    vi.stubGlobal('chrome', { runtime: { id: 'invalid' } });
    expect(runtimeGone()).toBe(true);
  });
  it('is false for a live runtime, and a plain error is not an orphan', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'abc' } });
    expect(runtimeGone()).toBe(false);
    expect(isContextInvalidated(new Error('Receiving end does not exist'))).toBe(false);
  });
});
