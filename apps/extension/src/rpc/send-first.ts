/**
 * A send goes ahead of catch-up sync.
 *
 * While a transaction is planned or built, the block processor holds still: a
 * wallet catching up on blocks otherwise shares the worker (and the tree) with
 * the planner and the prover, and the send waits on sync for nothing. Every
 * send lands here, from the worker's own penumbra-send listener and from a
 * dapp alike, so this is the one seam that covers both.
 *
 * The hold nests with the closed-window pause (see BlockProcessor.hold) and is
 * released when the call ends - returned, thrown or aborted - so sync never
 * stays held after a failed plan. Broadcast is not held: a dapp that awaits
 * detection needs sync running to see its transaction land.
 *
 * Each phase also logs one `[penumbra-timing]` line, for timing a real send.
 */

import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import type { CustodyService, ViewService } from '@penumbra-zone/protobuf';
import { servicesCtx } from '@penumbrafi/services/ctx/prax';
import { penumbraTiming } from '../penumbra/timing';

type ViewImpl = Partial<ServiceImpl<typeof ViewService>>;
type CustodyImpl = Partial<ServiceImpl<typeof CustodyService>>;

/** hold the block processor behind this request's services; nothing when they are a stub */
export type HoldSync = (ctx: HandlerContext) => Promise<(() => void) | undefined>;

const holdServicesSync: HoldSync = async ctx => {
  try {
    const services = await ctx.values.get(servicesCtx)();
    const { blockProcessor } = await services.getWalletServices();
    // hold lives on zafu's block processor, not the shared interface
    return (blockProcessor as { hold?: () => () => void }).hold?.();
  } catch {
    // stub services: nothing syncs, and the call itself reports why
    return undefined;
  }
};

/** release once the request ends, however it ends */
const holdFor = async (ctx: HandlerContext, hold: HoldSync | undefined) => {
  const release = await hold?.(ctx);
  if (release) {
    ctx.signal.addEventListener('abort', release, { once: true });
  }
  return release;
};

const unary =
  <I, O>(phase: string, impl: (req: I, ctx: HandlerContext) => O, hold?: HoldSync) =>
  async (req: I, ctx: HandlerContext): Promise<Awaited<O>> => {
    const t = performance.now();
    penumbraTiming(`${phase} start`);
    const release = await holdFor(ctx, hold);
    let outcome = 'failed';
    try {
      const out = await impl(req, ctx);
      outcome = 'end';
      return out;
    } finally {
      release?.();
      penumbraTiming(`${phase} ${outcome}`, t);
    }
  };

const streaming = <I, O>(
  phase: string,
  impl: (req: I, ctx: HandlerContext) => AsyncIterable<O>,
  hold?: HoldSync,
) =>
  async function* (req: I, ctx: HandlerContext): AsyncGenerator<O> {
    const t = performance.now();
    penumbraTiming(`${phase} start`);
    const release = await holdFor(ctx, hold);
    let outcome = 'failed';
    try {
      yield* impl(req, ctx);
      outcome = 'end';
    } finally {
      release?.();
      penumbraTiming(`${phase} ${outcome}`, t);
    }
  };

/** the view service with sync held through planning and building */
export const sendFirst = (impl: ViewImpl, hold: HoldSync = holdServicesSync): ViewImpl => {
  const { transactionPlanner, authorizeAndBuild, witnessAndBuild, broadcastTransaction } = impl;
  return {
    ...impl,
    ...(transactionPlanner && {
      transactionPlanner: unary('planner', transactionPlanner.bind(impl), hold),
    }),
    ...(authorizeAndBuild && {
      authorizeAndBuild: streaming(
        'build (authorize and build)',
        authorizeAndBuild.bind(impl),
        hold,
      ),
    }),
    ...(witnessAndBuild && {
      witnessAndBuild: streaming('build (witness and build)', witnessAndBuild.bind(impl), hold),
    }),
    ...(broadcastTransaction && {
      broadcastTransaction: streaming('broadcast', broadcastTransaction.bind(impl)),
    }),
  };
};

/** timing only: the approval inside a build, so the build line can be read without it */
export const timedCustody = (impl: CustodyImpl): CustodyImpl => {
  const { authorize } = impl;
  return {
    ...impl,
    ...(authorize && { authorize: unary('approval (authorize)', authorize.bind(impl)) }),
  };
};
