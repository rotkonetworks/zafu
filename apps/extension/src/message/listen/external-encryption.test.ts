/**
 * A site's encryption keys follow the person's choice for it (rotation,
 * cross-site), the same as zafu_sign: the pubkey it is given, the key that
 * vouches for its post-quantum key, and the key that opens its boxes.
 */
import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes } from '@noble/hashes/utils';
import { pqKeyAuthMessage } from '@zafu/pq';
import { grantCapability } from '@repo/storage-chrome/origin';
import { localExtStorage } from '@repo/storage-chrome/local';
import { encryptionMessageListener } from './external-encryption';
import { signZid, ZID_PQ_SUITE, type ZidSitePreference } from '../../state/identity';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

vi.mock('../../needs-login', () => ({ throwIfNeedsLogin: async () => undefined }));
vi.mock('../../state/privacy', () => ({ isIdentityEnabledFromStorage: async () => true }));
vi.mock('../../state', () => ({
  useStore: {
    getState: () => ({
      keyRing: { selectedKeyInfo: { id: 'k' }, getMnemonic: async () => PHRASE },
    }),
  },
}));

const sender = (origin: string): chrome.runtime.MessageSender => ({
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId: 0,
  documentId: 'doc-1',
  documentLifecycle: 'active',
  origin,
  url: `${origin}/`,
});

const call = (req: unknown, origin: string): Promise<any> =>
  new Promise(resolve => {
    encryptionMessageListener(req, sender(origin), resolve);
  });

/** a site the person set up on the identity page */
const site = async (origin: string, pref?: ZidSitePreference) => {
  await grantCapability(origin, 'encrypt');
  if (pref) {
    const prefs = (await localExtStorage.get('zidPreferences')) ?? {};
    await localExtStorage.set('zidPreferences', { ...prefs, [origin]: pref });
  }
};

const signingKey = (origin: string, pref?: ZidSitePreference) =>
  signZid(PHRASE, origin, new Uint8Array([1]), pref).publicKey;

describe.each<[string, ZidSitePreference]>([
  ['rotated', { mode: 'site', rotation: 2, identity: 'default' }],
  ['cross-site', { mode: 'cross-site', rotation: 0, identity: 'default' }],
])('a %s site', (name, pref) => {
  const origin = `https://${name}.example`;

  it('is given the key zafu_sign signs with, and it vouches for the post-quantum key', async () => {
    await site(origin, pref);
    const res = await call({ type: 'zafu_zid_pubkey' }, origin);
    expect(res.pubkey).toBe(signingKey(origin, pref));
    expect(res.pubkey).not.toBe(signingKey(origin));
    const msg = pqKeyAuthMessage(ZID_PQ_SUITE, origin, res.pq_epoch, hexToBytes(res.pq_pubkey));
    expect(ed25519.verify(hexToBytes(res.pq_sig), msg, hexToBytes(res.pubkey))).toBe(true);
  });

  it('opens what was sealed to the keys it was given', async () => {
    await site(origin, pref);
    const keys = await call({ type: 'zafu_zid_pubkey' }, origin);
    const plaintext = btoa('table 7, seat 3');

    const classical = await call(
      { type: 'zafu_encrypt', recipient: keys.pubkey, plaintext },
      origin,
    );
    expect(await call({ type: 'zafu_decrypt', ...classical }, origin)).toEqual({ plaintext });

    const hybrid = await call(
      { type: 'zafu_encrypt', recipient: keys.pubkey, recipient_pq: keys.pq_pubkey, plaintext },
      origin,
    );
    expect(
      await call({ type: 'zafu_decrypt', ...hybrid, pq_epoch: keys.pq_epoch }, origin),
    ).toEqual({ plaintext });
  });
});

it('a site with no choice keeps the key it always had', async () => {
  const origin = 'https://plain.example';
  await site(origin);
  const res = await call({ type: 'zafu_zid_pubkey' }, origin);
  expect(res.pubkey).toBe(signingKey(origin));
});
