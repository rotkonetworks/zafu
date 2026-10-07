import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useRoutes } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the screens are lazy chunks; only the redirects are under test
vi.mock('../route-modules', () => ({ screen: () => ({}) }));

import { settingsRoutes } from './routes';
import { SCREENS } from '../../../links/router';
import { PopupPath } from '../paths';

const Where = () => {
  const { pathname, search } = useLocation();
  return createElement('output', null, `${pathname}${search}`);
};

const ROUTES = [
  ...settingsRoutes.filter(r => r.element),
  { path: '*', element: createElement(Where) },
];
const Routes = () => useRoutes(ROUTES);

/** where a path lands after its redirects */
const land = async (from: string): Promise<string> => {
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  await act(async () =>
    root.render(createElement(MemoryRouter, { initialEntries: [from] }, createElement(Routes))),
  );
  const out = container.textContent ?? '';
  act(() => root.unmount());
  return out;
};

describe('settings paths from before the six groups', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['/settings/privacy', PopupPath.SETTINGS_NETWORK],
    ['/settings/privacy/home', PopupPath.SETTINGS_NETWORK],
    ['/settings/privacy/connections', PopupPath.SETTINGS_CONNECTIONS],
    ['/settings/networks', PopupPath.SETTINGS_DEVICES],
    ['/settings/networks/all', PopupPath.SETTINGS_DEVICES],
    ['/settings/security-backup', PopupPath.SETTINGS_SECURITY],
    ['/settings/devices/all', PopupPath.SETTINGS_DEVICES],
  ])('%s lands on %s', async (from, to) => {
    expect(await land(from)).toBe(to);
  });

  it("keeps the home's switch-node links: ?network= opens that chain's node sheet", async () => {
    expect(await land('/settings/networks?network=zcash')).toBe(
      `${PopupPath.SETTINGS_ZCASH_NETWORK}?sheet=node`,
    );
    expect(await land('/settings/networks?network=penumbra')).toBe(
      `${PopupPath.SETTINGS_PENUMBRA_NETWORK}?sheet=node`,
    );
  });

  it('keeps every zafu: settings link name, each at its new home', () => {
    expect(SCREENS['settings/privacy']).toBe(PopupPath.SETTINGS_NETWORK);
    expect(SCREENS['settings/networks']).toBe(PopupPath.SETTINGS_DEVICES);
    expect(SCREENS['settings/networks/zcash']).toBe(PopupPath.SETTINGS_ZCASH_NETWORK);
    expect(SCREENS['settings/networks/penumbra']).toBe(PopupPath.SETTINGS_PENUMBRA_NETWORK);
    expect(SCREENS['settings/security']).toBe(PopupPath.SETTINGS_SECURITY);
    expect(SCREENS['settings/about']).toBe(PopupPath.SETTINGS_ABOUT);
  });
});
