import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CARD_DEFAULT_RELAY, type CardV2 } from '@repo/wallet/networks/zcash/card-v2';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import { NoteLine } from './card-notes';

const from: CardV2 = {
  kind: 'card',
  revision: 3,
  key: 'aa'.repeat(32),
  pairKa: 'bb'.repeat(32),
  zcash: '11'.repeat(43),
  relay: CARD_DEFAULT_RELAY,
  caps: 3,
  created: 1,
};
const to: CardV2 = { ...from, kind: 'update', revision: 4, zcash: '22'.repeat(43) };
const item = (body: object) => ({
  hash: 'n:x',
  author: '',
  name: '',
  body: JSON.stringify(body),
  ts: 1_790_000_000,
  epoch: 0,
  kind: 'note' as const,
  mine: true,
});

describe('notes in a thread', () => {
  const el = document.createElement('div');
  const root = createRoot(el);
  afterEach(() => act(() => root.render(null)));

  it('an update says what changed and who signed it; the sheet says from what to what', async () => {
    await act(async () =>
      root.render(createElement(NoteLine, { item: item({ ev: 'update', from, to }), name: 'ken' })),
    );
    expect(el.textContent).toContain("ken's address changed · signed by ken");
    await act(async () => el.querySelector('button')!.click());
    const sheet = document.body.textContent ?? '';
    expect(sheet).toContain("ken's card changed");
    expect(sheet).toContain('the same key as before');
    expect(sheet).toContain('3 → 4');
    expect(sheet).toContain('paying ken uses the new address from now');
  });

  it('a confirmation says they have your card', async () => {
    await act(async () =>
      root.render(createElement(NoteLine, { item: item({ ev: 'confirmed' }), name: 'ken' })),
    );
    expect(el.textContent).toContain('ken has your card');
  });
});
