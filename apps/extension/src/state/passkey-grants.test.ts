import { describe, expect, it, vi } from 'vitest';

vi.mock('@repo/storage-chrome/local', () => ({ localExtStorage: {} }));
vi.mock('@repo/storage-chrome/session', () => ({ sessionExtStorage: {} }));
vi.mock('./encrypted-storage', () => ({
  readEncryptedWithMigration: vi.fn(),
  writeEncryptedDirect: vi.fn(),
}));

const { grantsFor } = await import('./passkey-grants');

const grant = (origin: string, rpId: string, userId?: string) => ({
  origin,
  rpId,
  owner: 'w',
  userId,
  at: 1,
});

describe('which passkeys may answer a sign-in', () => {
  const grants = [
    grant('https://app.corp.test', 'corp.test', 'aa'),
    grant('https://other.example', 'other.example', 'bb'),
  ];

  it("the page's own passkey for that rpId", () => {
    expect(grantsFor(grants, 'https://app.corp.test', 'corp.test')?.map(g => g.userId)).toEqual([
      'aa',
    ]);
  });

  it('one made for the same rpId on a sibling page: made on app., signed in on login.', () => {
    expect(grantsFor(grants, 'https://login.corp.test', 'corp.test')?.map(g => g.userId)).toEqual([
      'aa',
    ]);
  });

  it('never one made for another rpId', () => {
    expect(grantsFor(grants, 'https://other.example', 'corp.test')?.map(g => g.rpId)).toEqual([
      'corp.test',
    ]);
    expect(grantsFor(grants, 'https://app.corp.test', 'elsewhere.test')).toEqual([]);
  });

  it('nothing recorded for the page or the rpId: the caller may offer a pre-grant passkey once', () => {
    expect(grantsFor(grants, 'https://new.example', 'new.example')).toBeUndefined();
  });
});
