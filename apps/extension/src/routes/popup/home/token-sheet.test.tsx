import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { TokenSheet } from './penumbra-home';
import type { useTransparent } from './transparent-lines';
import type { Asset } from './penumbra-value';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const transparent: ReturnType<typeof useTransparent> = {
  shieldButton: () => undefined,
  chainLines: () => null,
  found: () => undefined,
  onlyThere: () => [],
  sheet: null,
};

const usdtAxl: Asset = {
  key: 'transfer/channel-24/uusdt',
  base: 'transfer/channel-24/uusdt',
  symbol: 'USDT.axl',
  name: 'Tether USD',
  um: false,
  amount: 12.5,
  local: {},
};

const um: Asset = {
  key: 'um',
  base: 'upenumbra',
  symbol: 'UM',
  name: 'Penumbra',
  um: true,
  amount: 33.5,
  local: {},
};

describe('token sheet denom line', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderAsset = async (asset: Asset) => {
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(TokenSheet, {
            token: { asset },
            transparent,
            onClose: () => undefined,
          }),
        ),
      );
    });
  };

  it('shows the bridged asset base denom as a copyable mono line', async () => {
    await renderAsset(usdtAxl);
    expect(document.body.textContent).toContain('transfer/channel-24/uusdt');
    const line = [...document.querySelectorAll('span.font-mono')].find(
      s => s.textContent === 'transfer/channel-24/uusdt',
    );
    expect(line).not.toBeUndefined();
    expect(document.querySelector('button[aria-label="copy"]')).not.toBeNull();
  });

  it('does not show a denom line for a native, non-bridged asset', async () => {
    await renderAsset(um);
    expect(document.body.textContent).not.toContain('upenumbra');
  });
});
