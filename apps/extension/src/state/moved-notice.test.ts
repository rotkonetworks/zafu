import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showMoved, stampSeenVersion } from './moved-notice';

describe('showMoved', () => {
  it('tells someone coming from the old layout', () => {
    expect(showMoved('28.3.1')).toBe(true);
    expect(showMoved('27.9.12')).toBe(true);
  });

  it('stays quiet once seen, on a fresh install, or with nothing stamped', () => {
    expect(showMoved('28.3.2')).toBe(false);
    expect(showMoved('28.10.0')).toBe(false);
    expect(showMoved('29.0.0')).toBe(false);
    expect(showMoved(undefined)).toBe(false);
  });
});

describe('stampSeenVersion', () => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '28.4.0' }) },
    storage: {
      local: {
        get: (k: string) => Promise.resolve(k in store ? { [k]: store[k] } : {}),
        set: (v: Record<string, unknown>) => Promise.resolve(void Object.assign(store, v)),
      },
    },
  });
  beforeEach(() => {
    delete store['lastSeenVersion'];
  });

  it('stamps a fresh install with its own version, so it is never told', async () => {
    await stampSeenVersion('install');
    expect(showMoved(store['lastSeenVersion'])).toBe(false);
  });

  it('remembers where an update came from, once', async () => {
    await stampSeenVersion('update', '28.3.1');
    expect(store['lastSeenVersion']).toBe('28.3.1');
    expect(showMoved(store['lastSeenVersion'])).toBe(true);
    await stampSeenVersion('update', '28.4.0');
    expect(store['lastSeenVersion']).toBe('28.3.1');
  });
});
