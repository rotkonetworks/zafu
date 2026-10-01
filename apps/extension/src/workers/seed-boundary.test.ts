// The zcash spend path never carries the recovery phrase outside the zcash
// worker. The worker and the prover relay cannot be stood up under vitest
// (IndexedDB, the rayon wasm, chrome.runtime, a live endpoint), so this guards
// the boundary in their source; the runtime half is prove-guard, which the
// worker runs before every prove-request and the offscreen document on arrival.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PROVER_FNS } from '../shared/prove-guard';

// vitest runs from apps/extension
const read = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');
const WORKER = read('workers/zcash-worker.ts');
const NETWORK = read('state/keyring/network-worker.ts');
const PROVER = read('zcash-build-parallel.ts');
const OFFSCREEN = read('entry/offscreen-handler.ts');

/** the source of every call `head(...)`, parentheses balanced */
const calls = (src: string, head: string): string[] => {
  const out: string[] = [];
  for (let at = src.indexOf(head); at !== -1; at = src.indexOf(head, at + 1)) {
    let depth = 0;
    for (let i = at + head.length - 1; i < src.length; i++) {
      depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0;
      if (depth === 0) {
        out.push(src.slice(at, i + 1));
        break;
      }
    }
  }
  return out;
};

const SECRET = /\b(mnemonic|seed|seedPhrase|phrase|privkey\w*|vault)\b/i;

describe('seed boundary', () => {
  test('no prove request names a phrase, seed, private key or vault', () => {
    const proves = calls(WORKER, 'proveViaOffscreen(');
    expect(proves.length).toBeGreaterThan(10);
    for (const call of proves) {
      expect(call, call.slice(0, 80)).not.toMatch(SECRET);
    }
  });

  test('every hot build is proven from the signing account UFVK and signed in the worker', () => {
    const scopes = calls(WORKER, 'withSpendKeys(');
    // send-tx (ironwood + orchard), turnstile, send-tx-multi, shield
    expect(scopes).toHaveLength(5);
    for (const scope of scopes) {
      expect(scope).toMatch(/proveViaOffscreen\(/);
      expect(scope).toMatch(/keys\.sign_(pczt|shielding)\(/);
      expect(scope).not.toMatch(/Payload\.ufvk/);
    }
    for (const scope of scopes.slice(0, 4)) {
      expect(scope).toMatch(/args: \[\s*keys\.ufvk\(\),/);
    }
  });

  test('the worker checks a prove request before it leaves, the offscreen document on arrival', () => {
    expect(WORKER).toMatch(
      /const proveViaOffscreen = async \(req: ProveRequest\)[^]*?assertProveRequest\(req\);[^]*?self\.postMessage/,
    );
    expect(OFFSCREEN).toMatch(
      /const req = assertProveRequest\(raw\);[^]*?worker\.postMessage\(req\)/,
    );
  });

  test('the prover runs only its allowlisted functions', () => {
    const cases = [...PROVER.matchAll(/case '(\w+)':/g)].map(m => m[1]);
    expect(new Set(cases)).toEqual(new Set(PROVER_FNS));
    expect(PROVER).not.toMatch(
      /build_signed_|build_shielding_transaction|derive_transparent_privkey/,
    );
  });

  test('no message to the worker or the service worker carries a phrase for zcash spends or sync', () => {
    for (const type of ['send-tx', 'send-tx-multi', 'send-turnstile-migration', 'shield', 'sync']) {
      const sent = calls(NETWORK, 'callWorker(').filter(c => c.includes(`'${type}'`));
      expect(sent.length, type).toBeGreaterThan(0);
      for (const call of sent) {
        expect(call, type).not.toMatch(/\bmnemonic\b/);
      }
      // a hot call's vault is sealed to a key the worker issued for it
      if (type !== 'sync') {
        expect(sent[0], type).toMatch(/vault: (vault && \()?await sealFor\(network, vault\)/);
      }
    }
    // the service-worker relay forwards the prove request and nothing else
    expect(NETWORK).toMatch(/chrome\.runtime\.sendMessage\(\{ type: 'ZCASH_BUILD', request \}\)/);
  });

  test('the worker reads a vault, never a mnemonic, from its spend payloads', () => {
    for (const handler of ['send-tx', 'send-tx-multi', 'send-turnstile-migration', 'shield']) {
      const start = WORKER.indexOf(`case '${handler}': {`);
      const body = WORKER.slice(start, WORKER.indexOf('\n      case ', start + 1));
      expect(body, handler).toMatch(/vault\??: SealedVault/);
      expect(body, handler).not.toMatch(/\bmnemonic\b/);
    }
  });
});
