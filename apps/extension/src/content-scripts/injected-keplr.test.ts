/**
 * window.zafu used to sit on every page, telling any site or ad script that
 * zafu was installed. It now waits for the bridge: a connected site, or Keplr
 * compatibility switched on.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fromBridge = (direction: string) =>
  window.dispatchEvent(
    new MessageEvent('message', { data: { channel: 'zafu-keplr', direction }, source: window }),
  );

const slots = ['zafu', 'keplr', 'getOfflineSigner', 'getOfflineSignerOnlyAmino'];
const has = (slot: string) => slot in window;

describe('injected-keplr', () => {
  beforeEach(async () => {
    vi.resetModules();
    await import('./injected-keplr');
  });

  afterEach(() => {
    for (const slot of slots) {
      delete (window as unknown as Record<string, unknown>)[slot];
    }
  });

  test('puts nothing on a page by itself', () => {
    expect(slots.filter(has)).toEqual([]);
  });

  test('installs only window.zafu for a connected site', () => {
    fromBridge('native');

    expect(has('zafu')).toBe(true);
    expect(has('keplr')).toBe(false);
  });

  test('installs both providers when keplr compatibility is on', () => {
    fromBridge('enable');

    expect(has('zafu')).toBe(true);
    expect(has('keplr')).toBe(true);
  });
});
