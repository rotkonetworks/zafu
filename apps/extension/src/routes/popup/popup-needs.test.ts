import { describe, expect, it, vi } from 'vitest';

vi.mock('@repo/storage-chrome/local', () => ({ localExtStorage: { get: vi.fn() } }));
vi.mock('@repo/storage-chrome/session', () => ({ sessionExtStorage: { get: vi.fn() } }));

import { handlesOwnLogin, safeNext } from './popup-needs';

describe('locked screen guard rules', () => {
  it('leaves login, home, approvals and signing flows alone', () => {
    for (const p of ['/', '/login', '/approval/tx', '/approval/zcash-send', '/cosmos-sign']) {
      expect(handlesOwnLogin(p)).toBe(true);
    }
  });
  it('guards wallet screens', () => {
    for (const p of ['/injective', '/send', '/receive', '/vote', '/settings/wallets']) {
      expect(handlesOwnLogin(p)).toBe(false);
    }
  });
  it('only returns to our own screens after unlock', () => {
    expect(safeNext('/injective')).toBe('/injective');
    expect(safeNext('/receive?mode=shield')).toBe('/receive?mode=shield');
    expect(safeNext('https://evil.example')).toBeNull();
    expect(safeNext('//evil.example')).toBeNull();
    expect(safeNext('/approval/tx')).toBeNull();
    expect(safeNext(null)).toBeNull();
  });
});
