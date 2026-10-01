import { describe, expect, it, vi } from 'vitest';

vi.mock('@repo/storage-chrome/local', () => ({ localExtStorage: {} }));

import { totalInOf } from './penumbra-total-in';

describe('penumbra total in', () => {
  it('shows um to anyone who never chose', () => {
    expect(totalInOf(undefined)).toBe('um');
  });

  it('keeps an explicit pick, usd included', () => {
    expect(totalInOf('usd')).toBe('usd');
    expect(totalInOf('um')).toBe('um');
  });
});
