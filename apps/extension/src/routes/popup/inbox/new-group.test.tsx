import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

let enabled: string[] = [];
vi.mock('../../../state', () => ({
  useStore: (sel: (s: unknown) => unknown) => sel({ keyRing: { enabledNetworks: enabled } }),
}));
vi.mock('../../../state/keyring', () => ({
  selectEnabledNetworks: (s: { keyRing: { enabledNetworks: string[] } }) =>
    s.keyRing.enabledNetworks,
}));
vi.mock('../../../people/client', () => ({ peopleAsk: vi.fn() }));
vi.mock('../../../components/screen-header', () => ({
  ScreenHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import { NewGroupPage } from './new-group';

const render = (url: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <NewGroupPage />
    </MemoryRouter>,
  );

describe('new group: a shared wallet is a zcash one', () => {
  it('offers a shared zcash wallet while zcash is on', () => {
    enabled = ['zcash', 'penumbra'];
    const html = render('/inbox/new-group?wallet=1');
    expect(html).toContain('shared zcash wallet');
    expect(html).not.toMatch(/>shared wallet</);
  });

  it('offers no shared wallet on a penumbra-only wallet, even when asked by link', () => {
    enabled = ['penumbra'];
    const html = render('/inbox/new-group?wallet=1');
    expect(html).not.toContain('shared');
    expect(html).toContain('new group');
  });
});
