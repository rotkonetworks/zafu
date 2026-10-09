/**
 * Zcash receive after "copy payment link": the code on screen is the request
 * that was copied (address, amount, memo), not the next fresh address, and
 * the address it carries is still retired so no second sender gets it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URI = 'zcash:u1first?amount=0.1234&memo=cWEgcmVxdWVzdA';
const copies: string[] = [];

vi.mock('../../../state', () => ({ useStore: () => true }));
vi.mock('../../../state/keyring', () => ({
  selectEffectiveKeyInfo: () => undefined,
  selectPenumbraAccount: () => 0,
  keyRingSelector: () => undefined,
}));
vi.mock('../../../state/wallets', () => ({
  getActiveWalletJson: () => undefined,
  selectZcashIsMainnet: () => true,
}));
vi.mock('../../../hooks/use-address', () => ({
  derivePenumbraEphemeralFromMnemonic: vi.fn(),
  derivePenumbraEphemeralFromFvk: vi.fn(),
}));
vi.mock('../../../hooks/use-transparent-addresses', () => ({
  useTransparentAddresses: () => ({ tAddresses: [], isLoading: false }),
}));
vi.mock('@repo/ui/hooks/use-copy', () => ({
  useCopy: () => ({ copied: false, copy: (text: string) => copies.push(text) }),
}));
vi.mock('../../../components/qr-code', () => ({
  QrCode: ({ value }: { value: string }) => <div data-qr={value} />,
}));
// the sheet's own fields are not under test: it hands back the link it copied
vi.mock('./payment-request', () => ({
  PaymentRequestSheet: ({ onCopied }: { onCopied: (uri: string) => void }) => (
    <button
      onClick={() => {
        copies.push(URI);
        onCopied(URI);
      }}
    >
      sheet copies
    </button>
  ),
}));

const { ZcashReceive } = await import('./receive-tab');

const qr = () => document.querySelector('[data-qr]')?.getAttribute('data-qr');
const press = (text: string) => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent === text);
  if (!b) {
    throw new Error(`no "${text}" button`);
  }
  act(() => b.click());
};

describe('zcash receive with a payment request', () => {
  let host: HTMLDivElement;
  let root: Root;
  const retire = vi.fn();
  const render = (address: string, stale = false) =>
    act(() =>
      root.render(
        <ZcashReceive
          address={address}
          loading={false}
          stale={stale}
          retireShielded={retire}
          addrType='shielded'
        />,
      ),
    );

  beforeEach(() => {
    copies.length = 0;
    retire.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('shows exactly the copied request, through the rotation, and copies it again', () => {
    render('u1first');
    expect(qr()).toBe('u1first');
    press('sheet copies');
    expect(retire).toHaveBeenCalledTimes(1);
    // the rotation lands: the screen still shows what was copied
    render('u1second', true);
    expect(qr()).toBe(URI);
    render('u1second');
    expect(qr()).toBe(URI);
    press('copy payment link');
    expect(copies).toEqual([URI, URI]);
    // done with it: the fresh address, never the one the request carried
    act(() => (document.querySelector('[aria-label="new address"]') as HTMLButtonElement).click());
    expect(qr()).toBe('u1second');
    expect(retire).toHaveBeenCalledTimes(1);
  });
});
