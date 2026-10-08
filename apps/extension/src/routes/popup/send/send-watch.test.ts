import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LIMITS, phaseOf, useSendWatch, watchNote, watchOf, type Watch } from './send-watch';
import { NYM_ANSWER_MS, NYM_BUDGET_MS } from '../../../net/nym-bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('watchOf', () => {
  it('reads each phase with its own sense of too quiet', () => {
    expect(watchOf('fetching chain tip', 0, 44_000)).toBe('ok');
    expect(watchOf('fetching chain tip', 0, 45_000)).toBe('slow');
    expect(watchOf('fetching chain tip', 0, 5 * 60_000)).toBe('timeout');
    // a catch-up and a prove are allowed longer
    expect(watchOf('catch-up: blocks', 0, 60_000)).toBe('ok');
    expect(watchOf('building, proving & signing ironwood tx (halo2)', 0, 120_000)).toBe('ok');
    expect(
      watchOf('building, proving & signing ironwood tx (halo2)', 0, LIMITS.proving.hardMs),
    ).toBe('timeout');
  });

  it('keeps a broadcast over nym inside its bound: routes tried, then the ask', () => {
    expect(LIMITS.broadcast.hardMs).toBeGreaterThan(NYM_BUDGET_MS + NYM_ANSWER_MS);
  });

  it('says only slow or another route on the note line', () => {
    expect(['ok', 'slow', 'rerouting', 'timeout'].map(w => watchNote(w as Watch))).toEqual([
      'leave',
      'slow',
      'rerouting',
      'leave',
    ]);
  });

  it('knows the phases', () => {
    expect(phaseOf(undefined)).toBe('default');
    expect(phaseOf('catch-up: start')).toBe('catch-up');
    expect(phaseOf('broadcasting transaction')).toBe('broadcast');
    expect(phaseOf('building & proving PCZT (halo2)')).toBe('proving');
  });
});

describe('useSendWatch on a fake clock', () => {
  let root: Root;
  let seen: Watch[];
  const Probe = (p: { steps: { step: string }[]; since: number; active: boolean }) => {
    seen.push(useSendWatch(p.steps, p.since, p.active));
    return null;
  };
  const render = (steps: { step: string }[], since: number, active = true) =>
    act(() => root.render(createElement(Probe, { steps, since, active })));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    seen = [];
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('turns slow after 45s of silence and recovers on the next label', () => {
    const since = Date.now();
    const steps = [{ step: 'loading wallet state' }];
    render(steps, since);
    act(() => vi.advanceTimersByTime(44_000));
    expect(seen.at(-1)).toBe('ok');
    act(() => vi.advanceTimersByTime(2_000));
    expect(seen.at(-1)).toBe('slow');
    render([...steps, { step: 'notes selected' }], since);
    expect(seen.at(-1)).toBe('ok');
  });

  it('does not let the proving heartbeat hide a prover that never answers', () => {
    const since = Date.now();
    let steps = [{ step: 'building, proving & signing ironwood tx (halo2)' }];
    render(steps, since);
    for (let t = 0; t < LIMITS.proving.hardMs; t += 2_000) {
      steps = [...steps, { step: 'proving (halo2)' }];
      render(steps, since);
      act(() => vi.advanceTimersByTime(2_000));
    }
    expect(seen.at(-1)).toBe('timeout');
  });

  it('ends a worker that never answers at all', () => {
    render([], Date.now());
    act(() => vi.advanceTimersByTime(LIMITS.default.hardMs));
    expect(seen.at(-1)).toBe('timeout');
  });

  it('watches nothing when no build runs', () => {
    render([], Date.now(), false);
    act(() => vi.advanceTimersByTime(LIMITS.default.hardMs * 2));
    expect(seen.at(-1)).toBe('ok');
  });
});
