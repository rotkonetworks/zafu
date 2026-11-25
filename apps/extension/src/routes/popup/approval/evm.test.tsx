/**
 * The evm approval as a person sees it: what a transaction does, read from
 * its data, and a connect that reaches a chain only with the person's yes.
 * The screen answers yes or no; it hands the worker nothing to sign.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { encodeFunctionData, erc20Abi, parseAbi } from 'viem';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../shared/components/origin-icon', () => ({
  OriginIcon: () => null,
  hostnameOf: (o: string) => new URL(o).hostname,
}));
const optIn = vi.hoisted(() => vi.fn());
vi.mock('../../../net/egress-opt-in', () => ({ requestEgressOptIn: optIn }));

const { EvmApproval } = await import('./evm');
const { EVM_CHAINS } = await import('../../../evm/chains');

const BRIDGE = '0x9A676e781A523b5d0C0e43731313A708CB607508';
const bsc = EVM_CHAINS[0]!;

let root: Root;
let host: HTMLElement;
const sent = vi.fn();

const show = async (req: Record<string, unknown>) => {
  await chrome.storage.session.set({
    'evmApproval:r1': { requestId: 'r1', origin: 'https://veil.example', chain: bsc, ...req },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/approval/evm?requestId=r1'] },
        createElement(EvmApproval),
      ),
    );
  });
  await vi.waitFor(() => expect(host.textContent).not.toContain('loading'));
};
const press = async (label: string) => {
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
  await act(async () => {
    [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click();
  });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sent.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(sent);
  vi.stubGlobal('close', vi.fn());
  optIn.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('evm approval', () => {
  it('reads an approve: who may spend how much of which token, and the fee', async () => {
    await show({
      kind: 'send',
      from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      token: { symbol: 'tNVDA', decimals: 18 },
      tx: {
        chainId: 56,
        to: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
        value: '0',
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [BRIDGE, 25n * 10n ** 17n],
        }),
        gas: '50000',
        gasPrice: '1000000000',
        nonce: 3,
      },
    });
    expect(host.textContent).toContain(`lets ${BRIDGE} spend 2.5 tNVDA from this address`);
    expect(host.textContent).toContain('up to 0.00005 BNB');
    expect(host.textContent).toContain('bnb smart chain (56)');
    await press('approve');
    expect(sent).toHaveBeenCalledWith({
      type: 'zafu_keplr_result',
      requestId: 'r1',
      result: { approved: true },
    });
  });

  const deposit = (chain: unknown) => ({
    kind: 'send',
    chain,
    token: { symbol: 'tUSDT', decimals: 18 },
    owner: 'not-yours',
    tx: {
      chainId: 31337,
      to: BRIDGE,
      value: '0',
      data: encodeFunctionData({
        abi: parseAbi([
          'function sendTransfer(address,uint256,string,string,uint64) payable returns (uint64)',
        ]),
        functionName: 'sendTransfer',
        args: [BRIDGE, 250n * 10n ** 18n, 'penumbra1abc', 'hi', 0n],
      }),
      gas: '1',
      gasPrice: '1',
      nonce: 0,
    },
  });

  it('reads a move into penumbra from a known bridge, loud when the receiver is not yours', async () => {
    await show(deposit(EVM_CHAINS.find(c => c.id === 31337)));
    expect(host.textContent).toContain('moves 250 tUSDT into penumbra');
    expect(host.textContent).toContain('memo');
    expect(host.querySelector('[role=alert]')?.textContent).toBe(
      "not an address of this wallet · if this is meant for you, please don't approve",
    );
  });

  it('reads the same call to an unknown contract as unreadable', async () => {
    await show(deposit(bsc));
    expect(host.textContent).not.toContain('penumbra');
    expect(host.textContent).toContain("zafu can't read what it does");
  });

  it('does not tell the person a signature moves nothing', async () => {
    await show({ kind: 'sign', message: '0x68656c6c6f' });
    expect(host.textContent).not.toContain('moves no funds');
    expect(host.textContent).toContain('the site can use this signature as yours');
  });

  it('shows a call it cannot read by its selector', async () => {
    await show({
      kind: 'send',
      tx: {
        chainId: 56,
        to: BRIDGE,
        value: '0',
        data: '0x12345678aabb',
        gas: '1',
        gasPrice: '1',
        nonce: 0,
      },
    });
    expect(host.textContent).toContain("calls 0x12345678 with 6 bytes of data · zafu can't read");
  });

  it('connects only once the person allows the chain rpc', async () => {
    optIn.mockResolvedValue(false);
    await show({ kind: 'connect' });
    expect(host.textContent).toContain('bsc-dataseed.bnbchain.org');
    await press('connect');
    expect(optIn).toHaveBeenCalledWith('bsc');
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ approved: false }) }),
    );
  });

  it('says no softly, and nothing is signed', async () => {
    await show({ kind: 'sign', message: '0x68656c6c6f' });
    expect(host.textContent).toContain('hello');
    await press('not now');
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ result: { approved: false, error: 'rejected' } }),
    );
  });
});
