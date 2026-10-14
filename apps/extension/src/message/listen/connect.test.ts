import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { pqKeyAuthMessage } from '@zafu/pq';
import { CONNECT_KA_SUITE } from '@zafu/protocol';
import type { Contact } from '../../state/contacts';
import { pairId } from '../../people/protocol';
import { createConnectListener, friendsOf, verifiedPeer, type ConnectDeps } from './connect';

const APP = 'https://zk.poker';

const person = (origin = APP) => {
  const sk = ed25519.utils.randomPrivateKey();
  const ka = bytesToHex(x25519.getPublicKey(x25519.utils.randomPrivateKey()));
  const msg = pqKeyAuthMessage(CONNECT_KA_SUITE, origin, 0, Buffer.from(ka, 'hex'));
  return {
    pubkey: bytesToHex(ed25519.getPublicKey(sk)),
    ka,
    ka_sig: bytesToHex(ed25519.sign(msg, sk)),
  };
};

const senderFor = (origin: string) =>
  ({
    tab: { id: 1 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc-1',
    documentLifecycle: 'active',
    origin,
    url: `${origin}/index.html`,
  }) as chrome.runtime.MessageSender;

const contact = (id: string, origin: string, handle: string): Contact =>
  ({ id, name: id, addresses: [], createdAt: 0, introduced: { origin, handle, at: 0 } }) as Contact;

const call = (deps: ConnectDeps, req: unknown, origin = APP) =>
  new Promise<unknown>(resolve => createConnectListener(deps)(req, senderFor(origin), resolve));

const depsWith = (over: Partial<ConnectDeps> = {}): ConnectDeps => ({
  locked: async () => false,
  contacts: async () => [],
  pairRooms: async () => new Set(),
  ask: vi.fn(async () => undefined),
  say: vi.fn(async () => undefined),
  ...over,
});

describe('zafu_connect', () => {
  it('takes a peer whose key signs its KA key for this site', () => {
    const p = person();
    expect(verifiedPeer(APP, p)).toEqual(p);
  });

  it('refuses a swapped KA key, and a key signed for another site', () => {
    const p = person();
    expect(verifiedPeer(APP, { ...p, ka: person().ka })).toBeUndefined();
    expect(verifiedPeer(APP, person('https://other.app'))).toBeUndefined();
  });

  it('answers pending whatever the person said, so the app never learns a no', async () => {
    const deps = depsWith();
    expect(await call(deps, { type: 'zafu_connect', peer: person(), name: 'mira' })).toEqual({
      status: 'pending',
    });
    expect(deps.ask).toHaveBeenCalledOnce();
  });

  it('a friend already connected here is said so, without asking again', async () => {
    const p = person();
    const deps = depsWith({
      contacts: async () => [contact('c1', APP, p.pubkey)],
      pairRooms: async () => new Set([pairId('c1')]),
    });
    expect(await call(deps, { type: 'zafu_connect', peer: p })).toEqual({
      status: 'connected',
      handle: p.pubkey,
    });
    expect(deps.ask).not.toHaveBeenCalled();
  });
});

describe('zafu_friends', () => {
  it('lists only the people this site introduced who are connected', () => {
    const rooms = new Set([pairId('a'), pairId('c')]);
    const all = [
      contact('a', APP, 'h1'),
      contact('b', APP, 'h2'),
      contact('c', 'https://other.app', 'h3'),
    ];
    expect(friendsOf(all, APP, rooms).map(f => f.handle)).toEqual(['h1']);
  });

  it('says nothing while locked', async () => {
    expect(
      await call(depsWith({ locked: async () => true }), { type: 'zafu_friends' }),
    ).toMatchObject({
      code: 'not_available',
    });
  });
});

describe('zafu_invite_friend', () => {
  it("puts a line into the friend's room, said as from this site", async () => {
    const deps = depsWith({
      contacts: async () => [contact('a', APP, 'h1')],
      pairRooms: async () => new Set([pairId('a')]),
    });
    expect(
      await call(deps, {
        type: 'zafu_invite_friend',
        handle: 'h1',
        text: 'table 7-fern-dusk',
        path: '/t/7',
      }),
    ).toEqual({ sent: true });
    expect(deps.say).toHaveBeenCalledWith(pairId('a'), 'table 7-fern-dusk · https://zk.poker/t/7');
  });

  it('refuses someone this site did not introduce', async () => {
    const deps = depsWith({
      contacts: async () => [contact('a', 'https://other.app', 'h1')],
      pairRooms: async () => new Set([pairId('a')]),
    });
    expect(
      await call(deps, { type: 'zafu_invite_friend', handle: 'h1', text: 'hi' }),
    ).toMatchObject({
      code: 'invalid_request',
    });
    expect(deps.say).not.toHaveBeenCalled();
  });
});
