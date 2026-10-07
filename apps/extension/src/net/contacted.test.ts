import { beforeEach, describe, expect, it } from 'vitest';
import { Key } from '@repo/encryption/key';
import { storage } from '@repo/mock-chrome';
import {
  CONTACTED_KEY,
  KEEP_DAYS,
  clearContacted,
  dayOf,
  flushContacted,
  noteContacted,
  parseContacted,
  pruneContacted,
  readContacted,
} from './contacted';

const DAY = 86_400_000;
const NOW = 20_000 * DAY + 50_000_000;

const unlock = async () => {
  const key = (await Key.create('test-password')).key;
  await storage.session.set({ passwordKey: await key.toJson() });
};

describe('what zafu contacted lately', () => {
  beforeEach(async () => {
    await storage.local.clear();
    await storage.session.clear();
    await clearContacted();
  });

  it('keeps counts and times per destination, nothing else', async () => {
    await unlock();
    noteContacted({ 'zcash-servers': { n: 3, at: NOW - 1000 } });
    noteContacted({ 'zcash-servers': { n: 2, at: NOW }, 'near-swap': { n: 1, at: NOW - 5000 } });
    await flushContacted(NOW);
    const log = await readContacted(NOW);
    expect(log).toEqual({
      'zcash-servers': { last: NOW, days: { [dayOf(NOW)]: 5 } },
      'near-swap': { last: NOW - 5000, days: { [dayOf(NOW)]: 1 } },
    });
    // the stored shape has room for counts only: no url, path or payload field survives a read
    expect(
      parseContacted({ x: { last: NOW, days: { [dayOf(NOW)]: 1 }, url: 'https://a/b?c' } }),
    ).toEqual({ x: { last: NOW, days: { [dayOf(NOW)]: 1 } } });
  });

  it('forgets days older than a week', async () => {
    const old = NOW - KEEP_DAYS * DAY;
    const log = {
      a: { last: old, days: { [dayOf(old)]: 4 } },
      b: { last: NOW, days: { [dayOf(old)]: 4, [dayOf(NOW)]: 1 } },
    };
    expect(pruneContacted(log, NOW)).toEqual({ b: { last: NOW, days: { [dayOf(NOW)]: 1 } } });
    await unlock();
    noteContacted({ a: { n: 4, at: old } });
    await flushContacted(old);
    expect(await readContacted(old)).not.toEqual({});
    expect(await readContacted(NOW)).toEqual({});
  });

  it('is sealed at rest, reads as empty while locked, and waits to write until unlocked', async () => {
    await unlock();
    noteContacted({ 'zcash-servers': { n: 1, at: NOW } });
    await flushContacted(NOW);
    const raw = (await storage.local.get(CONTACTED_KEY))[CONTACTED_KEY] as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['encrypted']);
    expect(JSON.stringify(raw)).not.toContain('zcash-servers');

    await storage.session.clear();
    expect(await readContacted(NOW)).toEqual({});
    noteContacted({ 'zcash-servers': { n: 2, at: NOW } });
    await flushContacted(NOW);
    expect((await storage.local.get(CONTACTED_KEY))[CONTACTED_KEY]).toEqual(raw);
  });

  it('starts afresh over a box that does not hold a log', async () => {
    const key = (await Key.create('test-password')).key;
    await storage.session.set({ passwordKey: await key.toJson() });
    await storage.local.set({
      [CONTACTED_KEY]: { encrypted: (await key.seal('not json')).toJson() },
    });
    noteContacted({ a: { n: 2, at: NOW } });
    await flushContacted(NOW);
    expect(await readContacted(NOW)).toEqual({ a: { last: NOW, days: { [dayOf(NOW)]: 2 } } });
  });

  it('clears', async () => {
    await unlock();
    noteContacted({ a: { n: 1, at: NOW } });
    await flushContacted(NOW);
    await clearContacted();
    expect(await storage.local.get(CONTACTED_KEY)).toEqual({});
    expect(await readContacted(NOW)).toEqual({});
  });
});
