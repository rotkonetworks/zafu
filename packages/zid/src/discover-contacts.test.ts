import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { discoverContacts } from './presence-service';
import type { PresenceService, DiscoveryPeer, PresentPeer } from './presence-service';

const peer = (id: string): DiscoveryPeer => ({
  id,
  friendPubHex: id.repeat(64).slice(0, 64),
  rootSecret: new Uint8Array(32).fill(1),
});

// a PresenceService whose findPresent returns a fixed present subset
const serviceReturning = (present: PresentPeer[]): PresenceService => ({
  async publishSelf() {},
  async findPresent() {
    return present;
  },
});

describe('discoverContacts — app response contract', () => {
  it('returns ONLY present contacts, reduced to id/sessionPubHex/caps', async () => {
    const sessionPub = new Uint8Array(32).fill(9);
    const service = serviceReturning([{ id: 'a', record: { sessionPub, caps: 3 } }]);

    // three contacts queried, only one present
    const out = await discoverContacts(service, [peer('a'), peer('b'), peer('c')]);

    expect(out).toEqual([{ id: 'a', sessionPubHex: bytesToHex(sessionPub), caps: 3 }]);
    // the absent contacts (b, c) never appear — full graph does not cross the boundary
    expect(out.map(c => c.id)).not.toContain('b');
    expect(out.map(c => c.id)).not.toContain('c');
  });

  it('leaks no root secret or contact card in the response', async () => {
    const service = serviceReturning([
      { id: 'a', record: { sessionPub: new Uint8Array(32).fill(2), caps: 0 } },
    ]);
    const out = await discoverContacts(service, [peer('a')]);
    expect(Object.keys(out[0]!).sort()).toEqual(['caps', 'id', 'sessionPubHex']);
  });

  it('returns empty when nobody is present', async () => {
    const out = await discoverContacts(serviceReturning([]), [peer('a'), peer('b')]);
    expect(out).toEqual([]);
  });
});
