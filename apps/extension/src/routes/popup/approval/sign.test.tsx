/** What the person sees before signing a site's challenge: the challenge itself. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { request } = vi.hoisted(() => ({ request: { challengeHex: '' } }));
vi.mock('../../../state', () => ({
  useStore: (select: (s: unknown) => unknown) =>
    select({
      signApproval: {
        origin: 'https://login.example',
        challengeHex: request.challengeHex,
        acceptRequest: vi.fn(),
        setChoice: vi.fn(),
        sendResponse: vi.fn(),
      },
      keyRing: { getMnemonic: vi.fn(), checkPassword: vi.fn() },
    }),
}));
vi.mock('../../../state/keyring', () => ({ selectEffectiveKeyInfo: () => undefined }));

import { SignApproval } from './sign';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

const render = async (challengeHex: string) => {
  request.challengeHex = challengeHex;
  const el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/approval/sign'] },
        createElement(SignApproval),
      ),
    );
  });
  return el;
};

describe('sign approval', () => {
  it('shows a short challenge whole', async () => {
    const el = await render('deadbeef');
    expect(el.textContent).toContain('challenge');
    expect(el.textContent).toContain('deadbeef');
  });

  it('shows a long challenge by its ends, with the whole of it a tap away', async () => {
    const hex = 'ab'.repeat(8) + 'cd'.repeat(40) + 'ef'.repeat(4);
    const el = await render(hex);
    expect(el.textContent).toContain('abababababababab');
    expect(el.textContent).toContain('efefefef');
    expect(el.querySelector(`[title="${hex}"]`)).not.toBeNull();
  });
});
