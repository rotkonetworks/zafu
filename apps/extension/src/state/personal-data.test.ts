import { beforeEach, describe, expect, test } from 'vitest';
import { clearPersonalData } from './personal-data';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

describe('clearPersonalData', () => {
  beforeEach(async () => {
    localMock.clear();
    await chrome.storage.local.set({
      txNotes: { tx: 'rent' },
      passwordLogins: [{ site: 'example.org' }],
      passkeyGrants: { 'example.org': 'wallet' },
      yourAddresses: [{ chain: 'bitcoin' }],
    });
  });

  test('clears only what it is asked to', async () => {
    await clearPersonalData({ notes: true, sent: false, logins: false, addresses: false });
    expect(localMock.has('txNotes')).toBe(false);
    expect(localMock.has('passwordLogins')).toBe(true);
    expect(localMock.has('passkeyGrants')).toBe(true);
    expect(localMock.has('yourAddresses')).toBe(true);
  });

  test('clears saved logins and your addresses when asked', async () => {
    await clearPersonalData({ notes: false, sent: false, logins: true, addresses: true });
    expect(localMock.has('txNotes')).toBe(true);
    expect(localMock.has('passwordLogins')).toBe(false);
    expect(localMock.has('passkeyGrants')).toBe(false);
    expect(localMock.has('yourAddresses')).toBe(false);
  });
});
