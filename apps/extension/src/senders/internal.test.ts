/**
 * `isValidInternalSender` is the gate for every message only zafu's own pages
 * and worker may send (worker control, approval results). A content script in a
 * web tab carries the extension id too, so the id alone must never pass.
 */
import { describe, expect, it } from 'vitest';
import { isValidInternalSender } from './internal';

const ext = `chrome-extension://${chrome.runtime.id}`;

describe('isValidInternalSender', () => {
  it('accepts an extension page, the offscreen document and the service worker', () => {
    expect(
      isValidInternalSender({
        id: chrome.runtime.id,
        origin: ext,
        url: `${ext}/popup.html`,
        documentId: 'd',
      }),
    ).toBe(true);
    // a popup window is still a tab, but its origin is the extension's
    expect(
      isValidInternalSender({
        id: chrome.runtime.id,
        origin: ext,
        url: `${ext}/popup.html#/approval/tx`,
        tab: { id: 4 } as chrome.tabs.Tab,
      }),
    ).toBe(true);
    // (the service worker - no origin, no document, an extension url - is
    // checked through URL.origin, which jsdom leaves "null" for chrome-extension:)
  });

  it('refuses a content script, another extension and a bare id', () => {
    expect(
      isValidInternalSender({
        id: chrome.runtime.id,
        origin: 'https://evil.example',
        url: 'https://evil.example/',
        tab: { id: 1 } as chrome.tabs.Tab,
        frameId: 0,
        documentId: 'd',
      }),
    ).toBe(false);
    expect(
      isValidInternalSender({ id: 'other', origin: 'chrome-extension://other', url: 'x' }),
    ).toBe(false);
    expect(isValidInternalSender({ id: chrome.runtime.id })).toBe(false);
  });
});
