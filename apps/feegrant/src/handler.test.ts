import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGrant, type HandlerDeps } from './handler';
import { GrantError } from './granter';
import { Limits } from './limits';

const GRANTER = 'inj1894x96sr2leg0y7rpkce9rqm3qujrhh3k78nq5';
const GRANTEE = 'inj1clwfv4vqh5ef25qg2e9cd5lwm2k287g8n557zd';

const deps = (over: Partial<HandlerDeps> = {}): HandlerDeps => ({
  config: {
    minUsdc: 1_000_000n,
    sponsorBelowInj: 1_000_000_000_000_000n,
    minGranterBalance: 100_000_000_000_000_000n,
    usdcDenom: 'erc20:x',
    stableDenoms: ['erc20:x', 'peggy0xusdt'],
  },
  granterAddress: GRANTER,
  ensureGrant: () =>
    Promise.resolve({ status: 'granted', txhash: 'H', height: '1', expiresAt: 'T' }),
  admit: () => null,
  recordGrant: () => undefined,
  balances: a =>
    Promise.resolve(
      a === GRANTER ? { usdc: 0n, inj: 10n ** 18n } : { usdc: 500_000_000n, inj: 0n },
    ),
  log: () => undefined,
  ...over,
});

describe('handleGrant', () => {
  it('grants an eligible address and records it', async () => {
    let recorded = 0;
    const res = await handleGrant(deps({ recordGrant: () => void (recorded += 1) }), '1.2.3.4', {
      address: GRANTEE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ granter: GRANTER, status: 'granted' });
    expect(recorded).toBe(1);
  });

  it('does not count a reused allowance against the budget', async () => {
    let recorded = 0;
    const res = await handleGrant(
      deps({
        ensureGrant: () => Promise.resolve({ status: 'exists' }),
        recordGrant: () => void (recorded += 1),
      }),
      'ip',
      { address: GRANTEE },
    );
    expect(res.status).toBe(200);
    expect(recorded).toBe(0);
  });

  it('rejects malformed addresses before touching the chain', async () => {
    let queried = false;
    const res = await handleGrant(
      deps({
        balances: () => {
          queried = true;
          return Promise.resolve({ usdc: 0n, inj: 0n });
        },
      }),
      'ip',
      { address: 'cosmos1abc' },
    );
    expect(res.status).toBe(400);
    expect(queried).toBe(false);
  });

  it('refuses addresses without USDC.inj', async () => {
    const res = await handleGrant(
      deps({ balances: () => Promise.resolve({ usdc: 0n, inj: 10n ** 18n }) }),
      'ip',
      {
        address: GRANTEE,
      },
    );
    expect(res).toMatchObject({ status: 409, body: { code: 'no_usdc' } });
  });

  it('refuses addresses that can pay their own gas', async () => {
    const res = await handleGrant(
      deps({
        balances: a =>
          Promise.resolve(
            a === GRANTER ? { usdc: 0n, inj: 10n ** 18n } : { usdc: 5_000_000n, inj: 10n ** 16n },
          ),
      }),
      'ip',
      { address: GRANTEE },
    );
    expect(res).toMatchObject({ status: 409, body: { code: 'has_inj' } });
  });

  it('stops granting and alerts when the sponsor runs low', async () => {
    const logs: string[] = [];
    const res = await handleGrant(
      deps({
        balances: a =>
          Promise.resolve(a === GRANTER ? { usdc: 0n, inj: 1n } : { usdc: 5_000_000n, inj: 0n }),
        log: m => logs.push(m),
      }),
      'ip',
      { address: GRANTEE },
    );
    expect(res.status).toBe(503);
    expect(logs.some(l => l.includes('ALERT'))).toBe(true);
  });

  it('passes limit denials through as 429', async () => {
    const res = await handleGrant(deps({ admit: () => 'daily_budget' }), 'ip', {
      address: GRANTEE,
    });
    expect(res).toMatchObject({ status: 429, body: { code: 'daily_budget' } });
  });

  it('marks unconfirmed grants as retryable', async () => {
    const res = await handleGrant(
      deps({
        ensureGrant: () => Promise.reject(new GrantError('not yet confirmed', true)),
      }),
      'ip',
      { address: GRANTEE },
    );
    expect(res).toMatchObject({ status: 503, body: { retryable: true } });
  });
});

describe('Limits', () => {
  const make = (now: () => Date) =>
    new Limits(
      {
        stateFile: join(mkdtempSync(join(tmpdir(), 'feegrant-')), 'state.json'),
        dailyGrantCap: 2,
        perIpDailyGrantCap: 1,
        perIpRequestsPerHour: 3,
      },
      now,
    );

  it('enforces per-IP and global daily grant caps', () => {
    const l = make(() => new Date('2026-09-24T10:00:00Z'));
    expect(l.admit('a')).toBeNull();
    l.recordGrant('a');
    expect(l.admit('a')).toBe('ip_daily');
    expect(l.admit('b')).toBeNull();
    l.recordGrant('b');
    expect(l.admit('c')).toBe('daily_budget');
  });

  it('rate-limits requests per IP per hour', () => {
    const l = make(() => new Date('2026-09-24T10:00:00Z'));
    expect(l.admit('a')).toBeNull();
    expect(l.admit('a')).toBeNull();
    expect(l.admit('a')).toBeNull();
    expect(l.admit('a')).toBe('ip_rate');
  });

  it('persists the global count across restarts and resets at UTC midnight', () => {
    let now = new Date('2026-09-24T10:00:00Z');
    const stateFile = join(mkdtempSync(join(tmpdir(), 'feegrant-')), 'state.json');
    const opts = { stateFile, dailyGrantCap: 1, perIpDailyGrantCap: 5, perIpRequestsPerHour: 50 };
    const first = new Limits(opts, () => now);
    first.recordGrant('a');
    const restarted = new Limits(opts, () => now);
    expect(restarted.admit('z')).toBe('daily_budget');
    now = new Date('2026-09-25T00:00:01Z');
    expect(restarted.admit('z')).toBeNull();
  });

  it('qualifies an address holding another stablecoin (USDT) instead of USDC.inj', async () => {
    const res = await handleGrant(
      deps({
        balances: a =>
          Promise.resolve(
            a === GRANTER
              ? { usdc: 0n, inj: 10n ** 18n }
              : { usdc: 0n, inj: 0n, all: [{ denom: 'PEGGY0xUSDT', amount: 2_000_000n }] },
          ),
      }),
      'ip',
      { address: GRANTEE },
    );
    expect(res.status).toBe(200);
  });

  it('does not qualify dust of a non-stable token', async () => {
    const res = await handleGrant(
      deps({
        balances: a =>
          Promise.resolve(
            a === GRANTER
              ? { usdc: 0n, inj: 10n ** 18n }
              : { usdc: 0n, inj: 0n, all: [{ denom: 'factory/x/meme', amount: 10n ** 30n }] },
          ),
      }),
      'ip',
      { address: GRANTEE },
    );
    expect(res).toMatchObject({ status: 409, body: { code: 'no_usdc' } });
  });

  it('asks for a send-capable grant when the purpose is send', async () => {
    let asked = '';
    await handleGrant(
      deps({
        ensureGrant: (_g, t) => {
          asked = t;
          return Promise.resolve({ status: 'exists' });
        },
      }),
      'ip',
      { address: GRANTEE, purpose: 'send' },
    );
    expect(asked).toBe('/cosmos.bank.v1beta1.MsgSend');
  });

  it('defaults to a shield (IBC transfer) grant', async () => {
    let asked = '';
    await handleGrant(
      deps({
        ensureGrant: (_g, t) => {
          asked = t;
          return Promise.resolve({ status: 'exists' });
        },
      }),
      'ip',
      { address: GRANTEE },
    );
    expect(asked).toBe('/ibc.applications.transfer.v1.MsgTransfer');
  });
});
