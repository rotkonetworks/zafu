// @vitest-environment-options {"url":"https://zafu.pro/c#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_-9"}
/**
 * A card or group link opened as a page (zafu.pro/c#..., /j#...) opens in
 * zafu once, only under the zafu: links setting, and only when it reads.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OPEN_LINK } from '../links/schemes';

vi.mock('../net/egress-install-lite', () => ({}));

const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
const tick = () => new Promise(r => setTimeout(r, 0));

/** the page moves to `path#hash` the way a pasted link does, and says so */
const goTo = async (url: string) => {
  history.pushState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await tick();
};

const sent = () => sendMessage.mock.calls.map(c => (c[0] as { uri: string }).uri);

describe('a zafu.pro card or group page', () => {
  beforeAll(async () => {
    sendMessage.mockClear();
    await import('./links');
    await tick();
  });

  it('hands the card link to zafu on load', () => {
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toEqual({ type: OPEN_LINK, uri: location.href });
  });

  it('hands each link over once', async () => {
    await goTo(location.href);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves a malformed link to the page', async () => {
    await goTo('/c#short');
    await goTo('/c#has%20spaces%20in%20it%20here');
    await goTo('/x#673-chaos-mail-kite');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('hands over a group link', async () => {
    await goTo('/j#673-chaos-mail-kite');
    expect(sent()).toEqual([
      'https://zafu.pro/c#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_-9',
      'https://zafu.pro/j#673-chaos-mail-kite',
    ]);
  });

  it('does nothing while zafu: links are off, on load or later', async () => {
    const off = { openZafuLinks: false };
    await chrome.storage.local.set({ privacySettings: off });
    // the mock storage never fires onChanged; chrome does, so say it here
    const onChanged = chrome.storage.onChanged.addListener as unknown as ReturnType<typeof vi.fn>;
    const changed = onChanged.mock.calls.at(-1)![0] as (
      c: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => void;
    changed({ privacySettings: { newValue: off } }, 'local');
    await goTo('/j#120-brave-tide-moss');
    vi.resetModules();
    await import('./links');
    await tick();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
