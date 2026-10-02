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
  it('carries send, swap and unshield as small icons, named for screen readers', () => {
    const row = render(um);
    expect(
      [...row.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label')),
    ).toEqual(expect.arrayContaining(['send um', 'swap um', 'unshield um']));
    for (const icon of ['i-lucide-arrow-up', 'i-lucide-arrow-left-right', 'i-ph-shield-slash']) {
      expect(row.querySelector(`.${icon}`)).not.toBeNull();
    }
  });

  it('offers no actions for an asset zafu cannot name', () => {
    const row = render({ ...um, base: undefined });
    expect(row.querySelector('[aria-label="send um"]')).toBeNull();
  });
});
