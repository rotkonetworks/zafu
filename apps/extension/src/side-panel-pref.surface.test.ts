import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyActionSurface } from './side-panel-pref';

const setPopup = vi.fn(() => Promise.resolve());
const setPanelBehavior = vi.fn(() => Promise.resolve());

vi.stubGlobal('chrome', {
  ...(globalThis as { chrome?: object }).chrome,
  action: { setPopup },
  sidePanel: { setPanelBehavior },
});

afterEach(() => {
  setPopup.mockClear();
  setPanelBehavior.mockClear();
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
