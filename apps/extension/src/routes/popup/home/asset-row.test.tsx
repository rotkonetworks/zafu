import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../hooks/penumbra-total-in', () => ({
  usePenumbraRowsInUsd: () => ({ inUsd: [], toggle: () => undefined }),
  usePenumbraTotalIn: () => ({ totalIn: 'usd', setTotalIn: () => undefined }),
}));
vi.mock('../../../components/sensitive', () => ({
  Sensitive: ({ children }: { children: unknown }) => <span>{children as string}</span>,
}));

import { AssetRow } from './penumbra-home';
import type { Asset } from './penumbra-value';

const um: Asset = {
  key: 'um',
  base: 'upenumbra',
  symbol: 'UM',
  name: 'Penumbra',
  um: true,
  amount: 33.5,
  local: {},
};

const render = (asset: Asset) => {
  const div = document.createElement('div');
  div.innerHTML = renderToStaticMarkup(
    <MemoryRouter>
      <AssetRow asset={asset} onOpen={() => undefined} />
    </MemoryRouter>,
  );
  return div;
};

describe('asset row', () => {
  it('is just the token: no actions until a check finds it on a deposit address', () => {
    const row = render(um);
    const labels = [...row.querySelectorAll('button[aria-label]')].map(b =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['show um in usd']);
    expect(row.textContent).not.toMatch(/transparent|not checked|ago/);
  });

  it('carries one small shield button once one is found', () => {
    const div = document.createElement('div');
    div.innerHTML = renderToStaticMarkup(
      <MemoryRouter>
        <AssetRow
          asset={um}
          onOpen={() => undefined}
          shield={{
            icon: 'i-ph-shield',
            label: 'shield um from injective',
            onPress: () => undefined,
          }}
        />
      </MemoryRouter>,
    );
    expect(
      div.querySelector('[aria-label="shield um from injective"] .i-ph-shield'),
    ).not.toBeNull();
  });
});
