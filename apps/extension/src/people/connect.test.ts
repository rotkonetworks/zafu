import { describe, expect, it } from 'vitest';
import { generateMnemonic } from 'bip39';
import { bytesToHex } from '@noble/hashes/utils';
import { connectSecret, deriveZidForSite, deriveZidKaForSite } from '../state/identity';
import { CARD_BODY } from './cards';
import { connectRole, connectRoom, connectRoomId, onConnect } from './connect';

const ORIGIN = 'https://zk.poker';

const side = (mnemonic: string, origin = ORIGIN) => ({
  zid: deriveZidForSite(mnemonic, 'default', origin).publicKey,
  ka: deriveZidKaForSite(mnemonic, 'default', origin),
});

describe('introductions', () => {
  const a = side(generateMnemonic(256));
  const b = side(generateMnemonic(256));

  it('both sides derive the same meeting secret, and only for this site', () => {
    const ab = bytesToHex(connectSecret(a.ka.seed, b.ka.publicKey, a.zid, b.zid, ORIGIN));
    const ba = bytesToHex(connectSecret(b.ka.seed, a.ka.publicKey, b.zid, a.zid, ORIGIN));
    expect(ab).toBe(ba);
    const other = bytesToHex(
      connectSecret(a.ka.seed, b.ka.publicKey, a.zid, b.zid, 'https://other.app'),
    );
    expect(other).not.toBe(ab);
  });

  it('a site key agreement key differs per site', () => {
    const m = generateMnemonic(256);
    expect(side(m).ka.publicKey).not.toBe(side(m, 'https://other.app').ka.publicKey);
  });

  it('exactly one side shows the card', () => {
    expect(connectRole(a.zid, b.zid)).not.toBe(connectRole(b.zid, a.zid));
  });

  it('a meeting room is per site and per person', () => {
    expect(connectRoomId(ORIGIN, b.zid)).toBe(connectRoomId(ORIGIN, b.zid));
    expect(connectRoomId(ORIGIN, b.zid)).not.toBe(connectRoomId('https://other.app', b.zid));
    expect(connectRoomId(ORIGIN, b.zid)).not.toBe(connectRoomId(ORIGIN, a.zid));
  });

  const room = (role: 'card' | 'answer') =>
    connectRoom(
      'w1',
      {
        origin: ORIGIN,
        peer: b.zid,
        name: 'mira',
        role,
        secret: 'aa'.repeat(32),
        gen: 0,
        j: 3,
        contactId: 'c1',
      },
      'https://relay.zafu.pro',
      1_800_000_000_000,
    );

  it('the answer side keeps the card that arrives, and only a card', async () => {
    const r = room('answer');
    const card = 'AQ'; // not a card: ignored
    expect(await onConnect(r, [{ body: CARD_BODY + card } as never])).toBeUndefined();
    expect(await onConnect(room('card'), [{ body: CARD_BODY + card } as never])).toBeUndefined();
  });
});
