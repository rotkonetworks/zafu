import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Source-level guards: zigner only ever signs a PCZT.
 *
 * The legacy `530402` request handed zigner a bare sighash plus randomizers
 * and a free-text summary, so the device signed a digest it could not check
 * against anything it showed. Every zigner flow now builds a PCZT, from which
 * zigner recomputes the sighash and shows what it proves. The worker cannot
 * be imported in a unit test (IndexedDB, wasm, offscreen prover), so these
 * read its source, like cold-send-bookkeeping.test.ts.
 */

const WORKER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'zcash-worker.ts'),
  'utf8',
);

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

describe('zigner signs a PCZT, never a bare sighash', () => {
  it('send-tx builds nothing for a device: cold sends go through send-tx-pczt', () => {
    const body = caseBody('send-tx');
    expect(body).not.toContain('stashColdSend');
    expect(body).not.toContain("'send-tx-unsigned'");
    expect(body).toContain('it sends through the pczt path');
  });

  it('cold shielding hands zigner the PCZT itself, as a full request', () => {
    // full: a compact answer cannot carry transparent signatures
    const body = caseBody('shield-unsigned');
    expect(body).toContain('zignerSignRequest(wasmModule, shieldUParsed.unsigned_tx_hex');
    expect(body).toContain('compact: false');
  });

  it('the legacy completion handlers are gone', () => {
    expect(WORKER_SRC).not.toContain("case 'send-tx-complete'");
    expect(WORKER_SRC).not.toContain("case 'shield-complete'");
  });
});
