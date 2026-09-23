import { describe, it, expect, beforeEach } from 'vitest';
import {
  nextHdIndex,
  peekHdIndex,
  resetHdIndex,
  checkAndBumpFreshAddressRateLimit,
  FRESH_ADDRESS_RATE_LIMIT_MAX,
  FRESH_ADDRESS_RATE_LIMIT_WINDOW_MS,
} from './cosmos-chain-counters';

// tests-setup.ts installs a mock chrome.storage + navigator.locks; every test
// starts with a fresh storage area because the mock is a fresh instance per
// import cycle. We still reset explicitly for tests that share state.

describe('nextHdIndex', () => {
  beforeEach(async () => {
    await resetHdIndex('injective');
    await resetHdIndex('osmosis');
  });

  it('starts at 0 (peek) and returns 1 on first allocation', async () => {
    expect(await peekHdIndex('injective')).toBe(0);
    const first = await nextHdIndex('injective');
    expect(first).toBe(1);
    expect(await peekHdIndex('injective')).toBe(1);
  });

  it('increments monotonically on serial calls', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(await nextHdIndex('injective'));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('two concurrent nextHdIndex calls return DIFFERENT values (lock race)', async () => {
    // Fire N parallel allocations; every returned value must be unique.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => nextHdIndex('injective')),
    );
    expect(new Set(results).size).toBe(N);
    // and they should be a permutation of 1..N (no gaps, no duplicates).
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  it('counters are independent per chain', async () => {
    await nextHdIndex('injective');
    await nextHdIndex('injective');
    const osmo = await nextHdIndex('osmosis');
    expect(osmo).toBe(1);
    expect(await peekHdIndex('injective')).toBe(2);
  });
});

describe('checkAndBumpFreshAddressRateLimit', () => {
  const origin = 'https://veil.example';
  const chainId = 'injective';

  it('allows up to MAX requests and refuses the MAX+1th', async () => {
    // Use a fixed `now` so the whole test lives inside one window.
    const now = 1_700_000_000_000;
    for (let i = 0; i < FRESH_ADDRESS_RATE_LIMIT_MAX; i++) {
      const r = await checkAndBumpFreshAddressRateLimit(origin, chainId, now);
      expect(r.ok, `call ${i + 1} should be allowed`).toBe(true);
    }
    const tripped = await checkAndBumpFreshAddressRateLimit(origin, chainId, now);
    expect(tripped.ok).toBe(false);
    if (!tripped.ok) {
      // retryAfterMs must be positive and no larger than the window size.
      expect(tripped.retryAfterMs).toBeGreaterThan(0);
      expect(tripped.retryAfterMs).toBeLessThanOrEqual(FRESH_ADDRESS_RATE_LIMIT_WINDOW_MS);
    }
  });

  it('resets after the window rolls over', async () => {
    const now = 2_000_000_000_000;
    // Fill the window.
    for (let i = 0; i < FRESH_ADDRESS_RATE_LIMIT_MAX; i++) {
      await checkAndBumpFreshAddressRateLimit(origin, chainId, now);
    }
    // Second call in-window trips the limit.
    const tripped = await checkAndBumpFreshAddressRateLimit(origin, chainId, now);
    expect(tripped.ok).toBe(false);
    // Advance past the window: allocation succeeds again.
    const later = now + FRESH_ADDRESS_RATE_LIMIT_WINDOW_MS + 1;
    const reopened = await checkAndBumpFreshAddressRateLimit(origin, chainId, later);
    expect(reopened.ok).toBe(true);
  });

  it('limits are per-origin AND per-chain (cross-key isolation)', async () => {
    const now = 3_000_000_000_000;
    for (let i = 0; i < FRESH_ADDRESS_RATE_LIMIT_MAX; i++) {
      await checkAndBumpFreshAddressRateLimit('https://a.example', 'injective', now);
    }
    // a.example on injective is exhausted...
    const a = await checkAndBumpFreshAddressRateLimit('https://a.example', 'injective', now);
    expect(a.ok).toBe(false);
    // ...but a different origin, or a different chain, still has a full window.
    const b = await checkAndBumpFreshAddressRateLimit('https://b.example', 'injective', now);
    expect(b.ok).toBe(true);
    const c = await checkAndBumpFreshAddressRateLimit('https://a.example', 'osmosis', now);
    expect(c.ok).toBe(true);
  });
});
