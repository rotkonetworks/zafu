import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../../components/sensitive', () => ({
  Sensitive: ({ children }: { children: unknown }) => <span>{children as string}</span>,
}));
vi.mock('../../../components/qr-code', () => ({
  QrCode: ({ value }: { value: string }) => <svg data-qr={value} />,
}));

import { DepositCard, untilLabel } from './deposit-card';

const NOW = 1_800_000_000_000;
const VAULT = 'bc1qvaultaddressxxxxxxxxxxxxxxxxxxxxxxxx';
const deal = {
  memo: '=:ZEC.ZEC:t1dest:1/1/0',
  amountInText: '0.01',
  depositAddress: VAULT,
  expiresAt: NOW + 10 * 60_000,
};

const render = (now: number) => {
  const el = document.createElement('div');
  el.innerHTML = renderToStaticMarkup(
    <DepositCard deal={deal} unit='btc' chain='bitcoin' now={now} />,
  );
  return el;
};

describe('the into-zec deposit card', () => {
  it('shows the vault to scan and copy, and the memo, while the window is open', () => {
    const el = render(NOW);
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.textContent).toContain(VAULT);
    expect(el.textContent).toContain(deal.memo);
    expect(el.querySelectorAll('button')).toHaveLength(2);
    expect(el.textContent).toContain('pay within 10:00');
  });

  it('once the quote expires, nothing is left to scan or copy', () => {
    const el = render(deal.expiresAt);
    expect(el.querySelector('svg')).toBeNull();
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.textContent).not.toContain(VAULT);
    expect(el.textContent).not.toContain(deal.memo);
    expect(el.textContent).toContain('the deposit window has closed');
  });

  it('a route with no deadline stays open', () => {
    const el = document.createElement('div');
    el.innerHTML = renderToStaticMarkup(
      <DepositCard deal={{ ...deal, expiresAt: undefined }} unit='btc' now={NOW} />,
    );
    expect(el.textContent).toContain(VAULT);
  });
});

describe('untilLabel', () => {
  it('ticks minutes and seconds under an hour', () => {
    expect(untilLabel(599)).toBe('9:59');
  });
  it('rounds to hours and minutes under two days', () => {
    expect(untilLabel(2 * 3600 + 13 * 60 + 5)).toBe('2 h 13 min');
  });
  it('shows days for a long deposit deadline', () => {
    expect(untilLabel(4439 * 60 + 49)).toBe('3 days');
  });
});
