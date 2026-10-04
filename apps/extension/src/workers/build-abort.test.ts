import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BuildStopped, createBuildRegistry, isBuildStopped } from './build-abort';

const never = <T>() => new Promise<T>(() => undefined);

describe('build registry', () => {
  it('a stop rejects the phase in flight at once, even one that never settles', async () => {
    const builds = createBuildRegistry();
    const build = builds.begin('a');
    const phase = build.race(never<string>());
    expect(builds.stop('a')).toBe('stopped');
    await expect(phase).rejects.toBeInstanceOf(BuildStopped);
    expect(() => build.check()).toThrow(BuildStopped);
    expect(() => build.commit()).toThrow(BuildStopped);
  });

  it('refuses a stop past the point of no return', async () => {
    const builds = createBuildRegistry();
    const build = builds.begin('a');
    build.commit();
    expect(builds.stop('a')).toBe('committed');
    // the broadcast goes on
    await expect(build.race(Promise.resolve('txid'))).resolves.toBe('txid');
    builds.end('a');
    expect(builds.stop('a')).toBe('committed');
  });

  it('a stop that arrives before its build stops it as it starts', async () => {
    const builds = createBuildRegistry();
    expect(builds.stop('early')).toBe('stopped');
    const build = builds.begin('early');
    await expect(build.race(Promise.resolve(1))).rejects.toBeInstanceOf(BuildStopped);
  });

  it('says a build that ended before broadcasting has nothing left to stop', () => {
    const builds = createBuildRegistry();
    builds.begin('cold');
    builds.end('cold');
    expect(builds.stop('cold')).toBe('ended');
  });

  it('a build without a key cannot be stopped from outside and is unaffected', async () => {
    const builds = createBuildRegistry();
    const build = builds.begin();
    expect(builds.stop('other')).toBe('stopped');
    await expect(build.race(Promise.resolve(2))).resolves.toBe(2);
  });

  it('a dropped phase that fails later is nobody’s unhandled error', async () => {
    const builds = createBuildRegistry();
    const build = builds.begin('a');
    let fail!: (e: Error) => void;
    const late = new Promise<never>((_, reject) => (fail = reject));
    const phase = build.race(late);
    builds.stop('a');
    await expect(phase).rejects.toBeInstanceOf(BuildStopped);
    fail(new Error('fetch failed'));
    await Promise.resolve();
  });

  it('the stopped message survives the trip across the worker boundary', () => {
    expect(isBuildStopped(new Error(new BuildStopped().message))).toBe(true);
    expect(isBuildStopped(new Error('insufficient funds'))).toBe(false);
  });
});

/**
 * Source guards on the worker, which cannot be imported in a unit test (see
 * cold-send-bookkeeping.test.ts): every stoppable build registers its key, and
 * no stop check sits after the point of no return.
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

describe('stoppable worker builds', () => {
  const STOPPABLE = [
    'send-tx',
    'send-tx-pczt',
    'send-turnstile-migration',
    'send-tx-multi',
    'shield',
    'shield-unsigned',
  ];

  it.each(STOPPABLE)('%s registers under the page key and races its slow phases', name => {
    const body = caseBody(name);
    expect(body).toMatch(/builds\.begin\(/);
    expect(body).toMatch(/build\.race\(/);
  });

  it.each(STOPPABLE)('%s commits before every broadcast and never checks after', name => {
    const body = caseBody(name);
    let from = 0;
    for (;;) {
      const at = body.indexOf('.sendTransaction(', from);
      if (at < 0) {
        break;
      }
      const before = body.slice(0, at);
      expect(
        before.lastIndexOf('build.commit()'),
        `${name}: broadcast without commit`,
      ).toBeGreaterThan(
        Math.max(before.lastIndexOf('build.race('), before.lastIndexOf('build.check()')),
      );
      from = at + 1;
    }
  });

  it('the dispatcher ends a keyed build however its handler ends', () => {
    expect(WORKER_SRC).toMatch(
      /finally \{\s*if \(typeof cancelKey === 'string'\) \{\s*builds\.end\(cancelKey\);/,
    );
  });
});
