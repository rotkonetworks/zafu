/**
 * The approval popup window is the only surface where the wallet can answer a
 * dapp, so "the window did not open" is not a cosmetic failure - the request
 * goes unanswered and the dapp falls back to the platform authenticator. These
 * tests pin the one way that happened: the top-right anchor is computed from the
 * browser window's geometry, and Chrome rejects a create whose bounds are less
 * than half inside the visible screen (a window dragged past the screen edge,
 * display scaling, a virtual display). The anchor is best-effort; the window is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  POPUP_WINDOW_HEIGHT,
  POPUP_WINDOW_WIDTH,
  openApprovalPopup,
  popupWindowGeometry,
} from './popup-window';

const URL_ = 'chrome-extension://ext/popup.html#/login';
const OFFSCREEN = () =>
  new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('popupWindowGeometry', () => {
  it('anchors to the top-right of the last-focused window in the canonical size', async () => {
    vi.stubGlobal('chrome', {
      windows: {
        getLastFocused: vi.fn().mockResolvedValue({ top: 40, left: 100, width: 1200, height: 800 }),
      },
    });

    expect(await popupWindowGeometry()).toEqual({
      width: POPUP_WINDOW_WIDTH,
      height: POPUP_WINDOW_HEIGHT,
      top: 40,
      left: 1300 - POPUP_WINDOW_WIDTH,
    });
  });

  it('never anchors at a negative coordinate', async () => {
    vi.stubGlobal('chrome', {
      windows: {
        getLastFocused: vi
          .fn()
          .mockResolvedValue({ top: -200, left: -50, width: 300, height: 400 }),
      },
    });

    expect(await popupWindowGeometry()).toMatchObject({ top: 0, left: 0 });
  });
});

describe('openApprovalPopup', () => {
  it('opens the canonical window at the anchor on the first try', async () => {
    const win = { id: 1 };
    const create = vi.fn().mockResolvedValue(win);
    vi.stubGlobal('chrome', {
      windows: {
        getLastFocused: vi.fn().mockResolvedValue({ top: 0, left: 1280, width: 1280 }),
        create,
      },
    });

    await expect(openApprovalPopup(URL_)).resolves.toBe(win);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      url: URL_,
      type: 'popup',
      focused: true,
      width: POPUP_WINDOW_WIDTH,
      height: POPUP_WINDOW_HEIGHT,
      top: 0,
      left: 1280 + 1280 - POPUP_WINDOW_WIDTH,
    });
  });

  it('falls back to Chrome placement when the anchor is off the visible screen', async () => {
    const create = vi.fn().mockRejectedValueOnce(OFFSCREEN()).mockResolvedValueOnce({ id: 2 });
    vi.stubGlobal('chrome', {
      windows: {
        getLastFocused: vi.fn().mockResolvedValue({ top: 10, left: 10, width: 1280 }),
        create,
      },
    });

    await expect(openApprovalPopup(URL_)).resolves.toEqual({ id: 2 });
    expect(create).toHaveBeenCalledTimes(2);
    // the retry keeps the sizing that the approval screens are laid out for and
    // drops the position, so Chrome places an on-screen window itself
    expect(create.mock.calls[1][0]).toEqual({
      url: URL_,
      type: 'popup',
      focused: true,
      width: POPUP_WINDOW_WIDTH,
      height: POPUP_WINDOW_HEIGHT,
    });
  });

  it('surfaces a real failure instead of pretending a window opened', async () => {
    const create = vi.fn().mockRejectedValue(new Error('no more windows'));
    vi.stubGlobal('chrome', {
      windows: {
        getLastFocused: vi.fn().mockResolvedValue({ top: 0, left: 0, width: 0 }),
        create,
      },
    });

    await expect(openApprovalPopup(URL_)).rejects.toThrow('no more windows');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
