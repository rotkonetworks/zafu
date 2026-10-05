import { describe, expect, it } from 'vitest';
import { UserChoice } from '@repo/storage-chrome/records';
import { hydrationGuard, toOriginRecords } from './persist';

describe('reads of encrypted storage, applied in order', () => {
  it('an older read that finishes last is not applied', () => {
    const next = hydrationGuard(() => 0);
    const first = next();
    const second = next();
    expect(second.newest()).toBe(true);
    expect(first.newest()).toBe(false);
  });

  it('a read a local write overtook leaves contacts as this realm has them', () => {
    let writes = 0;
    const next = hydrationGuard(() => writes);
    const read = next();
    // you renamed them while it was reading
    writes++;
    expect(read.newest()).toBe(true);
    expect(read.unwritten()).toBe(false);
    // the rename's own change starts a newer read, which applies
    expect(next().unwritten()).toBe(true);
  });
});

describe('knownSites as another build left them', () => {
  it('reads both shapes, and never throws on a missing denied, a null entry or a non-list', () => {
    expect(toOriginRecords(undefined)).toBeNull();
    expect(toOriginRecords({})).toBeNull();
    const sites = toOriginRecords([
      null,
      7,
      { origin: 'https://a.example', granted: ['connect'], grantedAt: 1 },
      { origin: 'https://b.example', granted: [], denied: ['connect'], grantedAt: 2 },
      { origin: 'https://c.example', granted: [] },
      { origin: 'https://d.example', choice: UserChoice.Approved, date: 3 },
    ]);
    expect(sites?.map(s => [s.origin, s.choice])).toEqual([
      ['https://a.example', UserChoice.Approved],
      ['https://b.example', UserChoice.Denied],
      ['https://c.example', UserChoice.Ignored],
      ['https://d.example', UserChoice.Approved],
    ]);
  });
});
