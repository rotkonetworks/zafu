/**
 * The keplr approval as a person sees it: the chain is the one the doc signs,
 * a direct doc reads as its messages, a doc zafu can't read has no approve,
 * and approve is the shared guarded button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  keyRing: { getMnemonic: vi.fn() },
  keyInfo: { id: 'w', name: 'zafu', type: 'mnemonic', insensitive: {} },
};
vi.mock('../../../state', () => ({
  useStore: (sel: (s: typeof state) => unknown) => sel(state),
}));
vi.mock('../../../state/keyring', () => ({
  keyRingSelector: (s: typeof state) => s.keyRing,
  selectEffectiveKeyInfo: (s: typeof state) => s.keyInfo,
}));
vi.mock('../../../shared/components/origin-icon', () => ({ OriginIcon: () => null }));
vi.mock('../../../shared/components/qr-display', () => ({ QrDisplay: () => null }));
vi.mock('../../../shared/components/qr-scanner', () => ({ QrScanner: () => null }));

const { KeplrApproval } = await import('./keplr');

// TxBody bytes (cosmjs-types): one MsgSend noble1a -> noble1recipient, then the same plus /odd.v1.MsgDrain
const SEND_BODY =
  'CjoKHC9jb3Ntb3MuYmFuay52MWJldGExLk1zZ1NlbmQSGgoHbm9ibGUxYRIPbm9ibGUxcmVjaXBpZW50';
const ODD_BODY =
  'CjoKHC9jb3Ntb3MuYmFuay52MWJldGExLk1zZ1NlbmQSGgoHbm9ibGUxYRIPbm9ibGUxcmVjaXBpZW50ChUKEC9vZGQudjEuTXNnRHJhaW4SAQE=';
const directDoc = (bodyBytesB64: string) => ({
  bodyBytesB64,
  authInfoBytesB64: '',
  chainId: 'noble-1',
  accountNumber: '1',
});

let root: Root;
let host: HTMLElement;

const show = async (req: Record<string, unknown>) => {
  await chrome.storage.session.set({ 'keplrApproval:r1': { requestId: 'r1', ...req } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/approval/keplr?requestId=r1'] },
        createElement(KeplrApproval),
      ),
    );
  });
  await vi.waitFor(() => expect(host.textContent).not.toContain('loading'));
};
const approveButton = () =>
  [...host.querySelectorAll('button')].find(b => b.textContent === 'approve')!;

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('keplr approval', () => {
  it('shows a direct doc as its messages, on the chain it signs', async () => {
    await show({
      method: 'signDirect',
      origin: 'https://dapp.example',
      chainId: 'noble-1',
      signDoc: directDoc(SEND_BODY),
    });
    expect(host.textContent).toContain('/cosmos.bank.v1beta1.MsgSend');
    expect(host.textContent).toContain('noble1recipient');
    expect(host.textContent).not.toContain(SEND_BODY);
  });

  it('holds approve back for a moment, as every approval does', async () => {
    await show({
      method: 'signDirect',
      origin: 'https://dapp.example',
      chainId: 'noble-1',
      signDoc: directDoc(SEND_BODY),
    });
    expect(approveButton().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(approveButton().disabled).toBe(false);
  });

  it('has no approve for a message zafu cannot read', async () => {
    await show({
      method: 'signDirect',
      origin: 'https://dapp.example',
      chainId: 'noble-1',
      signDoc: directDoc(ODD_BODY),
    });
    expect(host.textContent).toContain("zafu can't read /odd.v1.MsgDrain");
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(approveButton().disabled).toBe(true);
  });

  it('names the chain inside an amino doc', async () => {
    await show({
      method: 'signAmino',
      origin: 'https://dapp.example',
      chainId: 'osmosis-1',
      signDoc: {
        chain_id: 'osmosis-1',
        account_number: '1',
        sequence: '0',
        fee: { amount: [], gas: '1' },
        msgs: [],
        memo: '',
      },
    });
    expect(host.textContent).toContain('on osmosis-1');
  });
});
