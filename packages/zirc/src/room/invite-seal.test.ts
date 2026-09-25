import { describe, expect, it } from 'vitest';
import { createRoomSecret } from './room';
import { openInvite, sealInvite, type SealingIdentity } from './invite-seal';

/**
 * A stand-in for zid's sealed box: a real asymmetric primitive is not what
 * these tests are about. What they check is the part this module owns — that
 * an invite survives the round trip intact, that the wire form is JSON-safe,
 * and that a box addressed to someone else does not open.
 */
const pair = () => {
  const boxes = new Map<string, Uint8Array>();
  let n = 0;
  const identity = (who: string): SealingIdentity => ({
    sealFor: async (recipient, bytes) => {
      const id = `${String(recipient)}/${n++}`;
      boxes.set(id, bytes);
      return {
        ciphertext: new TextEncoder().encode(id),
        ephemeral_pubkey: new Uint8Array([1, 2, 3]),
        postQuantum: true,
        pq_epoch: 7,
      };
    },
    openSealed: async sealed => {
      const id = new TextDecoder().decode(sealed.ciphertext);
      if (!id.startsWith(`${who}/`)) {
        throw new Error('not addressed to me');
      }
      const bytes = boxes.get(id);
      if (!bytes) {
        throw new Error('no such box');
      }
      return bytes;
    },
  });
  return identity;
};

const invite = () => ({
  appScope: 'poker',
  channel: '#duel-4f2a',
  secret: createRoomSecret(),
  endpoint: 'https://zcash.rotko.net',
});

describe('sealed invites', () => {
  it('round-trips an invite through a sealed box', async () => {
    const id = pair();
    const alice = id('alice');
    const bob = id('bob');
    const original = invite();

    const sealed = await sealInvite(alice, 'bob', original);
    const opened = await openInvite(bob, sealed);

    expect(opened.appScope).toBe(original.appScope);
    expect(opened.channel).toBe(original.channel);
    expect([...opened.secret]).toEqual([...original.secret]);
    expect(opened.endpoint).toBe(original.endpoint);
  });

  it('survives JSON, which is what the transport will be', async () => {
    const id = pair();
    const original = invite();
    const sealed = await sealInvite(id('alice'), 'bob', original);

    const overTheWire = JSON.parse(JSON.stringify(sealed));
    const opened = await openInvite(id('bob'), overTheWire);
    expect([...opened.secret]).toEqual([...original.secret]);
  });

  it('reports whether the post-quantum path was taken', async () => {
    const sealed = await sealInvite(pair()('alice'), 'bob', invite());
    expect(sealed.postQuantum).toBe(true);
    expect(sealed.pqEpoch).toBe(7);
  });

  it('does not open for anyone but the recipient', async () => {
    const id = pair();
    const sealed = await sealInvite(id('alice'), 'bob', invite());
    await expect(openInvite(id('mallory'), sealed)).rejects.toThrow();
  });

  it('refuses an identity that cannot seal, rather than sending plaintext', async () => {
    await expect(sealInvite({}, 'bob', invite())).rejects.toThrow(/cannot seal/);
  });

  it('rejects a box that does not decrypt to an invite', async () => {
    const me: SealingIdentity = {
      openSealed: async () => new TextEncoder().encode('not an invite at all'),
    };
    await expect(
      openInvite(me, { ciphertext: 'aa', ephemeralPubkey: 'bb', postQuantum: false }),
    ).rejects.toThrow();
  });

  it('rejects malformed hex rather than decoding something else', async () => {
    const me: SealingIdentity = { openSealed: async () => new Uint8Array() };
    await expect(
      openInvite(me, { ciphertext: 'zz', ephemeralPubkey: 'bb', postQuantum: false }),
    ).rejects.toThrow(/not hex/);
  });
});
