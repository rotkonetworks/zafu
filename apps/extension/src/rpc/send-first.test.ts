import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '@connectrpc/connect';
import { sendFirst, type HoldSync } from './send-first';

/** a hold counter standing in for the block processor */
const holds = () => {
  let held = 0;
  const hold: HoldSync = () => {
    held += 1;
    let released = false;
    return Promise.resolve(() => {
      if (!released) {
        released = true;
        held -= 1;
      }
    });
  };
  return { hold, held: () => held };
};

const ctx = (signal = new AbortController().signal) => ({ signal }) as unknown as HandlerContext;

type Impl = Parameters<typeof sendFirst>[0];

describe('sendFirst', () => {
  it('holds sync through planning, and releases after a planning error', async () => {
    const h = holds();
    let heldDuring = -1;
    const view = sendFirst(
      {
        transactionPlanner: () => {
          heldDuring = h.held();
          return Promise.reject(new Error('insufficient funds'));
        },
      } as Impl,
      h.hold,
    );
    await expect(view.transactionPlanner!({} as never, ctx())).rejects.toThrow(
      'insufficient funds',
    );
    expect(heldDuring).toBe(1);
    expect(h.held()).toBe(0);
  });

  it('holds sync through a build stream and releases when it ends, throws or is left early', async () => {
    const h = holds();
    const seen: number[] = [];
    const view = sendFirst(
      {
        authorizeAndBuild: async function* () {
          seen.push(h.held());
          yield { status: { case: 'buildProgress' } };
          yield { status: { case: 'complete' } };
        },
        witnessAndBuild: async function* () {
          seen.push(h.held());
          yield await Promise.reject<never>(new Error('stale anchor'));
        },
      } as unknown as Impl,
      h.hold,
    );

    for await (const _ of view.authorizeAndBuild!({} as never, ctx())) {
      // drain
    }
    expect(h.held()).toBe(0);

    await expect(
      (async () => {
        for await (const _ of view.witnessAndBuild!({} as never, ctx())) {
          // drain
        }
      })(),
    ).rejects.toThrow('stale anchor');
    expect(h.held()).toBe(0);

    // a consumer that stops after the first message (an abort, a break)
    for await (const _ of view.authorizeAndBuild!({} as never, ctx())) {
      break;
    }
    expect(h.held()).toBe(0);
    expect(seen).toEqual([1, 1, 1]);
  });

  it('nests: two sends in flight hold until both end', async () => {
    const h = holds();
    let finish!: () => void;
    const view = sendFirst(
      {
        transactionPlanner: () => new Promise<never>(r => (finish = r as () => void)),
      } as Impl,
      h.hold,
    );
    const first = view.transactionPlanner!({} as never, ctx());
    const firstFinish = await new Promise<() => void>(r => setTimeout(() => r(finish)));
    const second = view.transactionPlanner!({} as never, ctx());
    await new Promise(r => setTimeout(r));
    expect(h.held()).toBe(2);
    firstFinish();
    await first;
    expect(h.held()).toBe(1);
    finish();
    await second;
    expect(h.held()).toBe(0);
  });

  it('an aborted request releases even while the impl is still stuck', async () => {
    const h = holds();
    const abort = new AbortController();
    const view = sendFirst(
      { transactionPlanner: () => new Promise<never>(() => undefined) } as Impl,
      h.hold,
    );
    void view.transactionPlanner!({} as never, ctx(abort.signal));
    await new Promise(r => setTimeout(r));
    expect(h.held()).toBe(1);
    abort.abort();
    expect(h.held()).toBe(0);
  });

  it('does not hold a broadcast: detection needs sync running', async () => {
    const h = holds();
    const seen: number[] = [];
    const view = sendFirst(
      {
        broadcastTransaction: async function* () {
          seen.push(h.held());
          yield { status: { case: 'broadcastSuccess' } };
        },
      } as unknown as Impl,
      h.hold,
    );
    for await (const _ of view.broadcastTransaction!({} as never, ctx())) {
      // drain
    }
    expect(seen).toEqual([0]);
  });
});
