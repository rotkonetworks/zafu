/**
 * The add-wallet sheet used to grey out "recovery phrase" with "wallet 1
 * already lives here", a leftover one-phrase-wallet limit. It is now a real
 * import row, the same as settings > wallets.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));
const openPageInTab = vi.fn();
vi.mock('../utils/popup-detection', () => ({
  openPageInTab: (...args: unknown[]) => openPageInTab(...args),
}));
vi.mock('../utils/navigate', () => ({
  screenTransition: () => undefined,
}));
vi.mock('@repo/ui/components/ui/sheet', () => ({
  Sheet: ({ children, title }: { children: unknown; title: string }) =>
    createElement('div', { 'data-title': title }, children as never),
}));

const { AddWalletSheet } = await import('./add-wallet-sheet');
const { PagePath } = await import('../routes/page/paths');

describe('add wallet sheet', () => {
  let root: Root;
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    openPageInTab.mockReset();
  });

  it('offers import of a recovery phrase instead of saying one already lives here', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => {
      root.render(createElement(AddWalletSheet, { open: true, onOpenChange: vi.fn() }));
    });
    expect(document.body.textContent).not.toMatch(/already lives here/i);
    const button = [...document.querySelectorAll('button')].find(b =>
      b.textContent?.includes('recovery phrase'),
    );
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
    expect(button!.textContent).toMatch(/import a phrase wallet/i);
    await act(async () => button!.click());
    expect(openPageInTab).toHaveBeenCalledWith(PagePath.IMPORT_SEED_PHRASE, true);
  });
});
