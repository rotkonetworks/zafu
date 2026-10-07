import { afterEach, describe, expect, it, vi } from 'vitest';
import { localExtStorage } from '@repo/storage-chrome/local';
import {
  applyActionSurface,
  initSidePanelPref,
  openPanelOnGesture,
  recentPanelOpenAccepted,
} from './side-panel-pref';

const setPopup = vi.fn(() => Promise.resolve());
const setPanelBehavior = vi.fn(() => Promise.resolve());
const open = vi.fn((_: { tabId: number }) => Promise.resolve());

vi.stubGlobal('chrome', {
  ...(globalThis as { chrome?: object }).chrome,
  action: { setPopup },
  sidePanel: { setPanelBehavior, open },
});

afterEach(() => {
  setPopup.mockClear();
  setPanelBehavior.mockClear();
  open.mockClear();
});

describe('toolbar icon follows the approval surface', () => {
  it.each(['hybrid', 'sidebar'] as const)('%s opens the side panel', surface => {
    applyActionSurface(surface);
    expect(setPopup).toHaveBeenCalledWith({ popup: '' });
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });

  it('popup opens the popup', () => {
    applyActionSurface('popup');
    expect(setPopup).toHaveBeenCalledWith({ popup: 'popup.html' });
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });
});

describe('the side panel opens on the dapp gesture', () => {
  const sender = { origin: 'https://dapp.example', tab: { id: 7 } as chrome.tabs.Tab };
  const useSurface = async (surface: 'hybrid' | 'sidebar' | 'popup') => {
    await localExtStorage.set('approvalSurface', surface);
    initSidePanelPref();
    await vi.waitFor(() => expect(setPopup).toHaveBeenCalled());
  };

  it.each(['hybrid', 'sidebar'] as const)(
    '%s opens it in the same task, and the approval knows it is coming',
    async surface => {
      await useSurface(surface);
      openPanelOnGesture(sender);
      expect(open).toHaveBeenCalledWith({ tabId: 7 });
      await expect(recentPanelOpenAccepted()).resolves.toBe(true);
    },
  );

  it('a refused open sends the approval straight to its fallback', async () => {
    await useSurface('hybrid');
    open.mockImplementationOnce(() => Promise.reject(new Error('no gesture')));
    openPanelOnGesture(sender);
    await expect(recentPanelOpenAccepted()).resolves.toBe(false);
  });

  it('popup never opens the panel', async () => {
    await useSurface('popup');
    openPanelOnGesture(sender);
    expect(open).not.toHaveBeenCalled();
  });

  it('a sender without a tab opens nothing', async () => {
    await useSurface('hybrid');
    openPanelOnGesture({ origin: sender.origin });
    expect(open).not.toHaveBeenCalled();
  });
});
