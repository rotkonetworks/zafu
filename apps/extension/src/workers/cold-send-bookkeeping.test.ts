import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Source-level guards for the cold-send bookkeeping.
 *
 * The worker is a DedicatedWorker module that reaches for IndexedDB, wasm and
 * an offscreen prover at import time, so its broadcast handlers cannot be
 * exercised in a unit test. What CAN be asserted cheaply is the property that
 * was broken: every handler that broadcasts a cold-signed transaction does the
 * same bookkeeping the hot paths do — mark the inputs spent, record the send.
 *
 * A wallet that skips it keeps counting spent notes as spendable, re-offers
 * them to the next send, and loses the recipient / memo / fee for good.
 */

const WORKER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'zcash-worker.ts'),
  'utf8',
);

/** Body of a `case '<name>': { ... }` block, by brace matching. */
const caseBody = (name: string): string => {
  const start = WORKER_SRC.indexOf(`case '${name}': {`);
  expect(start, `handler ${name} not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = WORKER_SRC.indexOf('{', start); i < WORKER_SRC.length; i++) {
    if (WORKER_SRC[i] === '{') {
      depth++;
    } else if (WORKER_SRC[i] === '}') {
      depth--;
      if (depth === 0) {
        return WORKER_SRC.slice(start, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
};

/** Every handler that broadcasts a transaction the wallet did not sign itself. */
const COLD_BROADCAST_HANDLERS = [
  'send-tx-complete',
  'send-tx-pczt-complete',
  'send-turnstile-migration-complete',
  'complete-orchard-pczt',
];

/** Every handler that hands an unsigned build out to a signing device. */
const COLD_BUILD_HANDLERS = ['send-tx', 'send-tx-pczt', 'send-turnstile-migration'];

describe('cold-send bookkeeping', () => {
  it.each(COLD_BROADCAST_HANDLERS)('%s marks inputs spent and records the send', name => {
    expect(caseBody(name)).toContain('finalizeColdBroadcast');
  });

  it.each(COLD_BUILD_HANDLERS)('%s stashes what the completion will need', name => {
    expect(caseBody(name)).toContain('stashColdSend');
  });

  it.each(COLD_BROADCAST_HANDLERS)('%s accepts the coldSendId from its build', name => {
    expect(caseBody(name)).toContain('coldSendId');
  });

  it('resolves a stashed context only by explicit id', () => {
    // Attaching the wrong context marks notes the transaction did not spend,
    // which is how a wallet loses access to its own money. There must be no
    // "just take the most recent one" fallback.
    const fn = WORKER_SRC.slice(
      WORKER_SRC.indexOf('const takeColdSend'),
      WORKER_SRC.indexOf('const finalizeColdBroadcast'),
    );
    expect(fn).toContain('if (!id) {');
    expect(fn).toMatch(/list\.find\(c => c\.id === id\)/);
  });

  it('does not throw out of the broadcast path', () => {
    // The network has already accepted the transaction by then; a bookkeeping
    // failure must not be reported to the user as a failed send.
    const fn = WORKER_SRC.slice(
      WORKER_SRC.indexOf('const finalizeColdBroadcast'),
      WORKER_SRC.indexOf('class IronwoodWitnessDrift'),
    );
    expect(fn).toContain('try {');
    expect(fn).toContain('catch');
  });
});

describe('fee model parity', () => {
  it('the send form uses the same ZIP-317 constants as the worker', async () => {
    const { MARGINAL_FEE } = await import('../routes/popup/send/spendable');
    const workerMarginal = WORKER_SRC.match(/const MARGINAL_FEE = (\d+)n;/);
    expect(workerMarginal).not.toBeNull();
    expect(MARGINAL_FEE).toBe(BigInt(workerMarginal![1]!));

    expect(WORKER_SRC).toContain('const GRACE_ACTIONS = 2;');
    expect(WORKER_SRC).toContain('const MIN_ORCHARD_ACTIONS = 2;');
  });
});
