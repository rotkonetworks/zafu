import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sheet } from '@repo/ui/components/ui/sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const isPassword = vi.fn(async (p: string) => p === 'right');
vi.mock('../../state', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({}),
}));
vi.mock('../../state/password', () => ({
  passwordSelector: () => ({ isPassword }),
}));

const { PasswordGateModal } = await import('./password-gate');

const settle = () => act(() => new Promise(r => setTimeout(r, 120)));

describe('PasswordGateModal', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // a shared wallet's "propose and seal" asks for the password from inside
  // its sheet: the gate must take the focus from the sheet, or nobody can
  // type the password
  it('takes the focus over an open sheet, and its password signs', async () => {
    const onConfirm = vi.fn();
    const render = (gate: boolean) =>
      root.render(
        createElement(
          'div',
          null,
          createElement(
            Sheet,
            { open: true, onOpenChange: () => undefined, title: 'send from the shared wallet' },
            createElement('button', null, 'propose and seal'),
          ),
          createElement(PasswordGateModal, { open: gate, onConfirm, onCancel: vi.fn() }),
        ),
      );
    act(() => render(false));
    await settle();
    act(() => render(true));
    await settle();
    const input = document.querySelector<HTMLInputElement>('input[placeholder=password]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    // the gate is a layer of its own, above the sheet
    expect(input!.closest('[role=dialog]')?.textContent).toContain('confirm this transaction');

    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, 'right');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(isPassword).toHaveBeenCalledWith('right');
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('Esc cancels once', async () => {
    const onCancel = vi.fn();
    act(() =>
      root.render(createElement(PasswordGateModal, { open: true, onConfirm: vi.fn(), onCancel })),
    );
    await settle();
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
