import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReloadNotice from './reload-notice';

// The invalidation latch is module state, and an orphaned document is exactly
// the thing that must only be reported once - so every test gets a fresh
// module instance rather than sharing the latch.
let notice: typeof ReloadNotice;

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  document.getElementById('zafu-reload-notice')?.remove();
  notice = await import('./reload-notice');
});

describe('noteContextInvalidated', () => {
  it('reports an orphaned context once, however many pokes arrive', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    notice.noteContextInvalidated();
    notice.noteContextInvalidated();
    notice.noteContextInvalidated();

    expect(debug).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('#zafu-reload-notice')).toHaveLength(1);
  });

  it('runs every teardown once, and never again', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    notice.onContextInvalidated(first);
    notice.onContextInvalidated(second);

    expect(first).not.toHaveBeenCalled();

    notice.noteContextInvalidated();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    notice.noteContextInvalidated();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs a teardown that registers after detection', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    notice.noteContextInvalidated();

    const late = vi.fn();
    notice.onContextInvalidated(late);

    expect(late).toHaveBeenCalledTimes(1);
  });

  it('keeps tearing down the rest when one teardown throws', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const boom = vi.fn(() => {
      throw new Error('teardown failed');
    });
    const after = vi.fn();
    notice.onContextInvalidated(boom);
    notice.onContextInvalidated(after);

    expect(() => notice.noteContextInvalidated()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
