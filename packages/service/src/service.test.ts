import { describe, expect, it } from 'vitest';

import {
  compose,
  composeStream,
  detachedContext,
  identityFilter,
  type Service,
  type ServiceContext,
  type ServiceFilter,
  type StreamFilter,
  type StreamService,
} from './service';

/** a minimal base service - the only "I/O leaf" in these tests. */
const double: Service<number, number> = n => Promise.resolve(n * 2);

const recorder =
  (log: string[], name: string): ServiceFilter =>
  inner =>
  async (req, ctx) => {
    log.push(`${name}-in`);
    const res = await inner(req, ctx);
    log.push(`${name}-out`);
    return res;
  };

describe('compose', () => {
  it('applies the first-listed filter outermost', async () => {
    const log: string[] = [];
    const svc = compose(recorder(log, 'a'), recorder(log, 'b'))(double);

    await expect(svc(3, detachedContext)).resolves.toBe(6);
    expect(log).toEqual(['a-in', 'b-in', 'b-out', 'a-out']);
  });

  it('is the identity when given no filters', async () => {
    const svc = compose()(double);
    await expect(svc(4, detachedContext)).resolves.toBe(8);
  });

  it('composes filters onto each other, keeping order', async () => {
    const log: string[] = [];
    const stack = compose(recorder(log, 'a'), recorder(log, 'b'));

    await expect(stack(double)(5, detachedContext)).resolves.toBe(10);
    expect(log).toEqual(['a-in', 'b-in', 'b-out', 'a-out']);
  });
});

describe('identityFilter', () => {
  it('leaves behaviour and context untouched', async () => {
    let seen: ServiceContext | undefined;
    const base: Service<string, string> = (req, ctx) => {
      seen = ctx;
      return Promise.resolve(req.toUpperCase());
    };

    const ctx = { signal: new AbortController().signal };
    await expect(identityFilter(base)('ok', ctx)).resolves.toBe('OK');
    expect(seen).toBe(ctx);
  });
});

describe('streaming services', () => {
  it('compose through StreamFilter with the same left-to-right order', async () => {
    // a hand-rolled async iterator rather than an `async function*` with nothing
    // to await: an AsyncIterable is what a stream service must return, and this is
    // one without pretending to be asynchronous internally.
    const range: StreamService<number, number> = count => ({
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: (): Promise<IteratorResult<number>> =>
            Promise.resolve(
              i < count ? { value: i++, done: false } : { value: undefined, done: true },
            ),
        };
      },
    });
    const shift: StreamFilter<number, number> = inner =>
      async function* (req, ctx) {
        for await (const value of inner(req, ctx)) {
          yield value + 10;
        }
      };
    const upTo12: StreamFilter<number, number> = inner =>
      async function* (req, ctx) {
        for await (const value of inner(req, ctx)) {
          if (value < 12) {
            yield value;
          }
        }
      };

    const collect = async (svc: StreamService<number, number>): Promise<number[]> => {
      const out: number[] = [];
      for await (const value of svc(5, detachedContext)) {
        out.push(value);
      }
      return out;
    };

    // first listed is outermost: shift(upTo12(range)) - the filter runs on the
    // values the inner one emitted, so the bound is checked BEFORE the shift.
    const shifted = composeStream<number, number>(shift, upTo12)(range);
    await expect(collect(shifted)).resolves.toEqual([10, 11, 12, 13, 14]);
    // upTo12(shift(range)) - the bound is checked on the shifted values instead.
    const bounded = composeStream<number, number>(upTo12, shift)(range);
    await expect(collect(bounded)).resolves.toEqual([10, 11]);
  });
});
