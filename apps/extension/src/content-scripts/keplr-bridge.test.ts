import { beforeAll, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { ZafuControl } from './message/zafu-control';

type Listener = (message: unknown, sender: chrome.runtime.MessageSender) => void;
let fromBackground: Listener;
let postSpy: Mock;

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'zafu',
      onMessage: { addListener: (l: Listener) => (fromBackground = l) },
    },
    storage: {
      local: { get: () => Promise.resolve({}) },
      onChanged: { addListener: () => undefined },
    },
  });
  await import('./keplr-bridge');
});

beforeEach(() => {
  postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
});

const nativePosted = () =>
  postSpy.mock.calls.some(([data]) => (data as { direction?: string }).direction === 'native');

describe('keplr-bridge window.zafu gate', () => {
  test.each([ZafuControl.Preconnect, ZafuControl.Init])(
    'asks for window.zafu on %s from zafu',
    control => {
      fromBackground(control, { id: 'zafu' });
      expect(nativePosted()).toBe(true);
    },
  );

  test('ignores the same message from another extension', () => {
    fromBackground(ZafuControl.Preconnect, { id: 'other' });
    expect(nativePosted()).toBe(false);
  });

  test('ignores End', () => {
    fromBackground(ZafuControl.End, { id: 'zafu' });
    expect(nativePosted()).toBe(false);
  });
});
