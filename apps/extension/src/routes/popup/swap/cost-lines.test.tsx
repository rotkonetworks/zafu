import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const list = vi.hoisted(() => ({ bps: 0 }));
vi.mock('../../../config/swap-fee', () => ({ zafuListBps: () => list.bps }));
vi.mock('../../../components/sensitive', () => ({
  Sensitive: ({ children }: { children: unknown }) => <span>{children as string}</span>,
}));

import { CostList } from './cost-lines';
import { costOf } from '../../../state/swap/provider';

const render = (el: JSX.Element) => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(el);
  return { container };
};

const cost = costOf([
  { label: 'thorchain', bps: 30, out: 71_825n },
  { label: 'zafu fee', bps: 0, out: 0n, zafu: true },
]);

describe('cost lines', () => {
  it('shows a route zafu takes nothing on as a plain 0%, not a discount', () => {
    list.bps = 10;
    const { container } = render(<CostList cost={cost} unit='zec' decimals={8} />);
    expect(container.querySelector('s')).toBeNull();
    expect(container.textContent).toContain('zafu fee0% · 0 zec');
    expect(container.textContent).toContain('total ≈0.3% · 0.00071825 zec');
  });

  it('strikes the list rate through beside the discounted rate', () => {
    list.bps = 10;
    const half = costOf([{ label: 'zafu fee', bps: 5, out: 1_000n, zafu: true }]);
    const { container } = render(<CostList cost={half} unit='zec' decimals={8} />);
    expect(container.querySelector('s')?.textContent).toBe('0.1%');
    expect(container.querySelector('.text-success')?.textContent).toBe('0.05% -50%');
  });

  it('shows a plain 0% when production charges nothing either', () => {
    list.bps = 0;
    const { container } = render(<CostList cost={cost} unit='zec' decimals={8} />);
    expect(container.querySelector('s')).toBeNull();
    expect(container.textContent).toContain('zafu fee0% · 0 zec');
  });
});
