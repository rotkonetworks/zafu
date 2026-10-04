import { describe, expect, it } from 'vitest';
import { handleBaseGas, serialize, type BaseGasDeps } from './base-gas';

const SPONSOR = '0x1111111111111111111111111111111111111111';
const HASH: `0x${string}` = `0x${'ab'.repeat(32)}`;
const BUYER = '0x2222222222222222222222222222222222222222';
const INTENT = { depositId: '42', amount: '50000000', platform: 'revolut', currency: 'USD' };

const deps = (over: Partial<BaseGasDeps> = {}): BaseGasDeps => ({
  config: { dripWei: 20n, fundedAboveWei: 10n, minSponsorWei: 100n },
  sponsorAddress: SPONSOR,
  balanceOf: a => Promise.resolve(a === SPONSOR ? 1000n : 0n),
  send: () => Promise.resolve(HASH),
  admit: () => null,
  recordGrant: () => undefined,
  lastDrip: new Map(),
  now: () => 1_000_000,
  log: () => undefined,
  ...over,
});

describe('handleBaseGas', () => {
  it('drips a fresh address and records it', async () => {
    let recorded = 0;
    const d = deps({ recordGrant: () => void (recorded += 1) });
    const r = await handleBaseGas(d, '1.2.3.4', { address: BUYER, intent: INTENT });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ wei: '20' });
    expect(recorded).toBe(1);
    expect(d.lastDrip.has(BUYER.toLowerCase())).toBe(true);
  });

  it('refuses a malformed address or intent before any network call', async () => {
    let calls = 0;
    const d = deps({ balanceOf: () => ((calls += 1), Promise.resolve(0n)) });
    expect((await handleBaseGas(d, 'ip', { address: '0x12', intent: INTENT })).status).toBe(400);
    expect((await handleBaseGas(d, 'ip', { address: BUYER, intent: {} })).status).toBe(400);
    expect(
      (await handleBaseGas(d, 'ip', { address: BUYER, intent: { ...INTENT, amount: '0' } })).status,
    ).toBe(400);
    expect((await handleBaseGas(d, 'ip', { address: SPONSOR, intent: INTENT })).status).toBe(400);
    expect(calls).toBe(0);
  });

  it('says funded when the address can pay its own gas', async () => {
    const d = deps({ balanceOf: a => Promise.resolve(a === SPONSOR ? 1000n : 10n) });
    const r = await handleBaseGas(d, 'ip', { address: BUYER, intent: INTENT });
    expect(r.status).toBe(409);
  });

  it('drips one address once a day', async () => {
    const d = deps();
    expect((await handleBaseGas(d, 'ip', { address: BUYER, intent: INTENT })).status).toBe(200);
    const again = await handleBaseGas(d, 'ip', { address: BUYER, intent: INTENT });
    expect(again.status).toBe(429);
    expect(again.body['retryAfter']).toBe(86_400);
  });

  it('honours the ip and daily limits', async () => {
    const r = await handleBaseGas(deps({ admit: () => 'daily_budget' }), 'ip', {
      address: BUYER,
      intent: INTENT,
    });
    expect(r.status).toBe(429);
  });

  it('stops when the sponsor runs low', async () => {
    const d = deps({ balanceOf: a => Promise.resolve(a === SPONSOR ? 110n : 0n) });
    const r = await handleBaseGas(d, 'ip', { address: BUYER, intent: INTENT });
    expect(r.status).toBe(503);
  });

  it('frees the address again when the send fails', async () => {
    const d = deps({ send: () => Promise.reject(new Error('nonce too low')) });
    const r = await handleBaseGas(d, 'ip', { address: BUYER, intent: INTENT });
    expect(r.status).toBe(502);
    expect(d.lastDrip.size).toBe(0);
  });
});

describe('serialize', () => {
  it('runs sends one at a time, even after a failure', async () => {
    const order: string[] = [];
    let first = true;
    const run = serialize(async (x: string) => {
      order.push(`start ${x}`);
      await new Promise(r => {
        setTimeout(r, 5);
      });
      if (first) {
        first = false;
        throw new Error('boom');
      }
      order.push(`end ${x}`);
      return x;
    });
    const a = run('a').catch(() => 'failed');
    const b = run('b');
    expect(await a).toBe('failed');
    expect(await b).toBe('b');
    expect(order).toEqual(['start a', 'start b', 'end b']);
  });
});
