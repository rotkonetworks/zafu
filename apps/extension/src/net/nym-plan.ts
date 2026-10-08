/**
 * The nym choices as layers: each setting is `(ctx, decision) => decision`,
 * folded in one ordered list per question. The order is the precedence:
 * defaults < per-device choice < per-network choice < hard denies. A new
 * setting is a new layer in the right place, never a branch in another.
 *
 * Pure: `./egress-policy` builds the transport context while compiling the
 * table, the service worker builds the plan context at the edge.
 */

import type { OptInChoice } from './destination';

type Layer<C, D> = (ctx: C, d: D) => D;

const fold =
  <C, D>(init: D, layers: readonly Layer<C, D>[]) =>
  (ctx: C): D =>
    layers.reduce((d, layer) => layer(ctx, d), init);

export type Transport = 'nym' | 'direct' | 'off';

export interface TransportCtx {
  /** the network's default (NYM_GROUPS), or undefined when it has no nym rows */
  groupDefault?: boolean;
  /** the person's per-network choice, `optIns['nym:<network>']` */
  choice?: OptInChoice;
  /** the request names you (a nym class row) */
  names: boolean;
  /** nym's exits reach the node's port */
  exitPort: boolean;
  /** "send over nym" */
  master: boolean;
  /** the destination is allowed at all */
  destinationOn: boolean;
}

const toDirect = (d: Transport): Transport => (d === 'nym' ? 'direct' : d);

export const transportFor = fold<TransportCtx, Transport>('direct', [
  // default
  (c, d) => (c.groupDefault ? 'nym' : d),
  // per-network choice
  (c, d) => (c.choice ? (c.choice === 'allowed' ? 'nym' : 'direct') : d),
  // hard: nothing to hide, nym cannot exit there, master off, destination off
  (c, d) => (c.names ? d : toDirect(d)),
  (c, d) => (c.exitPort ? d : toDirect(d)),
  (c, d) => (c.master ? d : toDirect(d)),
  (c, d) => (c.destinationOn ? d : 'off'),
]);

/** `up`: keep the tunnel running; `leave`: on demand, as asked; `down`: stop it */
export type NymPlan = 'up' | 'leave' | 'down';

export interface PlanCtx {
  /** "keep nym ready while unlocked", per device */
  keepReady: boolean;
  /** some enabled network or service sends over nym right now */
  carries: boolean;
  master: boolean;
  unlocked: boolean;
}

export const nymPlan = fold<PlanCtx, NymPlan>('leave', [
  // per-device choice
  (c, d) => (c.keepReady ? 'up' : d),
  // per-network choice: nothing uses it
  (c, d) => (c.carries ? d : 'down'),
  // hard
  (c, d) => (c.master ? d : 'down'),
  (c, d) => (c.unlocked ? d : 'down'),
]);
