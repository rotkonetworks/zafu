import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { sealChatFrame, openChatFrame } from './group-chat-crypto';

/** a fresh x25519 identity, hex like StoredRelayIdentity. */
const identity = () => {
  const priv = randomBytes(32);
  return { priv: bytesToHex(priv), pub: bytesToHex(x25519.getPublicKey(priv)) };
};

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('group-chat-crypto', () => {
  const session = 'session-uuid-1';

  it('round-trips a message between two identities', async () => {
    const alice = identity();
    const bob = identity();

    const sealed = await sealChatFrame(alice.priv, bob.pub, session, enc('gm bob'));
    const opened = await openChatFrame(bob.priv, alice.pub, session, sealed);

    expect(dec(opened)).toBe('gm bob');
  });

  it('is stateless - a freshly built key opens a frame sealed earlier', async () => {
    // this is the property Noise_K lacked: the popup can close and reopen (a
    // brand new module state) and still read what queued while it was gone.
    const alice = identity();
    const bob = identity();

    const sealed = await sealChatFrame(alice.priv, bob.pub, session, enc('queued while away'));

    // simulate a totally independent later invocation: only hex strings survive
    const bobPrivLater = bob.priv;
    const alicePubLater = alice.pub;
    const opened = await openChatFrame(bobPrivLater, alicePubLater, session, sealed);

    expect(dec(opened)).toBe('queued while away');
  });

  it('a third party cannot open a frame between two others', async () => {
    const alice = identity();
    const bob = identity();
    const eve = identity();

    const sealed = await sealChatFrame(alice.priv, bob.pub, session, enc('secret'));

    // eve tries with her own key, claiming alice as sender
    await expect(openChatFrame(eve.priv, alice.pub, session, sealed)).rejects.toThrow();
  });

  it('opening under the wrong claimed sender fails - authorship is the key, not the label', async () => {
    const alice = identity();
    const bob = identity();
    const mallory = identity();

    const sealed = await sealChatFrame(alice.priv, bob.pub, session, enc('from alice'));

    // bob receives it but a lying relay labels the sender as mallory
    await expect(openChatFrame(bob.priv, mallory.pub, session, sealed)).rejects.toThrow();
    // labelled correctly, it opens
    expect(dec(await openChatFrame(bob.priv, alice.pub, session, sealed))).toBe('from alice');
  });

  it('a frame is bound to its session - it cannot be replayed into another', async () => {
    const alice = identity();
    const bob = identity();

    const sealed = await sealChatFrame(alice.priv, bob.pub, 'session-A', enc('hi'));

    await expect(openChatFrame(bob.priv, alice.pub, 'session-B', sealed)).rejects.toThrow();
  });

  it('both directions of the same pair derive the same key', async () => {
    const alice = identity();
    const bob = identity();

    const aToB = await sealChatFrame(alice.priv, bob.pub, session, enc('ping'));
    const bToA = await sealChatFrame(bob.priv, alice.pub, session, enc('pong'));

    expect(dec(await openChatFrame(bob.priv, alice.pub, session, aToB))).toBe('ping');
    expect(dec(await openChatFrame(alice.priv, bob.pub, session, bToA))).toBe('pong');
  });

  it('tampered ciphertext is rejected (GCM tag)', async () => {
    const alice = identity();
    const bob = identity();

    const sealed = await sealChatFrame(alice.priv, bob.pub, session, enc('intact'));
    const bytes = hexToBytes(sealed);
    bytes[bytes.length - 1] ^= 0xff; // flip a tag bit
    const tampered = bytesToHex(bytes);

    await expect(openChatFrame(bob.priv, alice.pub, session, tampered)).rejects.toThrow();
  });
});
