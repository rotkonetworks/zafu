import { beforeAll, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { ZafuControl } from './message/zafu-control';

type Listener = (message: unknown, sender: chrome.runtime.MessageSender) => void;
let fromBackground: Listener;
let postSpy: Mock;
const sendMessage = vi.fn();

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'zafu',
      sendMessage,
      onMessage: { addListener: (l: Listener) => (fromBackground = l) },
    },
    storage: {
      local: { get: () => Promise.resolve({ evmWindowEthereum: true }) },
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

describe('keplr-bridge relays', () => {
  const fromPage = (channel: string) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { channel, direction: 'request', id: '1', method: 'm', params: [] },
        source: window,
      }),
    );
  const answered = () =>
    vi.waitFor(() => {
      const reply = postSpy.mock.calls.find(
        ([d]) => (d as { direction?: string }).direction === 'response',
      );
      expect(reply).toBeDefined();
      return reply![0] as Record<string, unknown>;
    });

  test('the evm channel to the worker, with its error code back', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'request rejected', code: 4001 });
    fromPage('zafu-evm');
    expect(await answered()).toMatchObject({ channel: 'zafu-evm', ok: false, code: 4001 });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'ZafuEvm', method: 'm', params: [] });
  });

  test('nothing from window.keplr while keplr compatibility is off', async () => {
    sendMessage.mockClear();
    fromPage('zafu-keplr');
    expect(await answered()).toMatchObject({ channel: 'zafu-keplr', ok: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('keplr-bridge for the evm provider', () => {
  test("passes the worker's chain change to the page, only from zafu", () => {
    const event = { type: 'ZafuEvmEvent', event: 'chainChanged', value: '0x61' };
    const relayed = () =>
      postSpy.mock.calls.filter(([d]) => (d as { direction?: string }).direction === 'event');
    fromBackground(event, { id: 'other' });
    expect(relayed()).toEqual([]);
    fromBackground(event, { id: 'zafu' });
    expect(relayed()[0]?.[0]).toEqual({
      channel: 'zafu-evm',
      direction: 'event',
      event: 'chainChanged',
      value: '0x61',
    });
  });
});
