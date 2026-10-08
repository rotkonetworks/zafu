import { describe, expect, it } from 'vitest';
import { nymPlan, transportFor, type PlanCtx, type TransportCtx } from './nym-plan';

const bools = [true, false];
const cartesian = <T extends Record<string, readonly unknown[]>>(axes: T) =>
  Object.entries(axes).reduce<Record<string, unknown>[]>(
    (rows, [k, vs]) => rows.flatMap(r => vs.map(v => ({ ...r, [k]: v }))),
    [{}],
  ) as { [K in keyof T]: T[K][number] }[];

describe('transportFor: every combination of the layers', () => {
  const rows = cartesian({
    master: bools,
    choice: ['allowed', 'blocked', undefined] as const,
    groupDefault: [true, false, undefined] as const,
    destinationOn: bools,
    names: bools,
    exitPort: bools,
  });

  it.each(rows)('%o', (c: TransportCtx) => {
    // the precedence, written out once more as the oracle
    const wanted = c.choice ? c.choice === 'allowed' : !!c.groupDefault;
    const expected = !c.destinationOn
      ? 'off'
      : c.master && c.names && c.exitPort && wanted
        ? 'nym'
        : 'direct';
    expect(transportFor(c)).toBe(expected);
  });

  it('a hard deny always wins over a network turned on', () => {
    const on = { choice: 'allowed', groupDefault: true, names: true, exitPort: true } as const;
    expect(transportFor({ ...on, master: false, destinationOn: true })).toBe('direct');
    expect(transportFor({ ...on, master: true, destinationOn: false })).toBe('off');
    expect(transportFor({ ...on, master: true, destinationOn: true })).toBe('nym');
  });
});

describe('nymPlan: every combination of the layers', () => {
  const rows = cartesian({ keepReady: bools, carries: bools, master: bools, unlocked: bools });

  it.each(rows)('%o', (c: PlanCtx) => {
    const expected = !c.unlocked || !c.master || !c.carries ? 'down' : c.keepReady ? 'up' : 'leave';
    expect(nymPlan(c)).toBe(expected);
  });

  it('locked, or the master off, stops it whatever else is on', () => {
    const on = { keepReady: true, carries: true };
    expect(nymPlan({ ...on, master: true, unlocked: false })).toBe('down');
    expect(nymPlan({ ...on, master: false, unlocked: true })).toBe('down');
  });
});
