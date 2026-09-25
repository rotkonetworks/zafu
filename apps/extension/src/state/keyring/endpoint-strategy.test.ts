import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STRATEGY,
  isManualStrategy,
  pickEndpoint,
  rankEndpoints,
  type Candidate,
  type SelectionStrategy,
} from './endpoint-strategy';

// Minimal preset stub — only needs `id` and `url` per EndpointLike.
const preset = (id: string, url = `https://${id}.example`) => ({ id, url });

const healthy = (latencyMs: number, behindBy = 0) => ({
  ok: true as const,
  latencyMs,
  behindBy,
  presetId: '',
  info: null,
  error: null,
});

const unhealthy = () => ({
  ok: false as const,
  latencyMs: 0,
  behindBy: null,
  presetId: '',
  info: null,
  error: 'boom',
});

// Cast to Candidate — the real EndpointHealth carries extra service-worker fields
// this test doesn't exercise; the ranker only reads ok/latencyMs/behindBy.
const c = (id: string, health: ReturnType<typeof healthy> | ReturnType<typeof unhealthy> | null) =>
  ({ preset: preset(id), health }) as unknown as Candidate<ReturnType<typeof preset>>;

describe('endpoint-strategy', () => {
  it('default strategy is fastest (no silent switch to manual)', () => {
    expect(DEFAULT_STRATEGY).toBe<SelectionStrategy>('fastest');
    expect(isManualStrategy(DEFAULT_STRATEGY)).toBe(false);
  });

  it('isManualStrategy narrows to manual only', () => {
    expect(isManualStrategy('manual')).toBe(true);
    expect(isManualStrategy('fastest')).toBe(false);
    expect(isManualStrategy('most-synced')).toBe(false);
    expect(isManualStrategy('random')).toBe(false);
  });

  describe('manual strategy', () => {
    const candidates = [c('a', healthy(50, 0)), c('b', healthy(10, 0)), c('c', healthy(200, 5))];

    it('rankEndpoints returns [] under manual — no auto ranking', () => {
      expect(rankEndpoints(candidates, 'manual')).toEqual([]);
    });

    it('pickEndpoint returns null under manual — signals "keep current"', () => {
      // This is what the UI's smart-pick handler and any store consumer
      // rely on: a null pick means "do not overwrite the user's URL".
      expect(pickEndpoint(candidates, 'manual')).toBeNull();
    });

    it('never falls back to another strategy — even with obviously fast healthy nodes', () => {
      // Prove the manual guard runs BEFORE the healthy filter / sort, so no
      // fastest/most-synced logic can accidentally win.
      const sortSpy = vi.spyOn(Array.prototype, 'sort');
      pickEndpoint(candidates, 'manual');
      expect(sortSpy).not.toHaveBeenCalled();
      sortSpy.mockRestore();
    });
  });

  describe('fastest strategy (smart-pick still works when NOT manual)', () => {
    it('picks the lowest-latency healthy endpoint', () => {
      const candidates = [
        c('slow', healthy(500, 0)),
        c('fast', healthy(10, 0)),
        c('medium', healthy(100, 0)),
      ];
      const picked = pickEndpoint(candidates, 'fastest');
      expect(picked?.preset.id).toBe('fast');
    });

    it('drops unhealthy candidates before ranking', () => {
      const candidates = [c('dead', unhealthy()), c('alive', healthy(200, 0))];
      const picked = pickEndpoint(candidates, 'fastest');
      expect(picked?.preset.id).toBe('alive');
    });

    it('returns null when every candidate is unhealthy (caller keeps current)', () => {
      const candidates = [c('a', unhealthy()), c('b', unhealthy())];
      expect(pickEndpoint(candidates, 'fastest')).toBeNull();
    });
  });

  describe('switching manual → fastest triggers a re-pick', () => {
    // Simulates the UI flow: while the user's strategy was 'manual' the picker
    // was a no-op. On switching to 'fastest', the panel calls pickEndpoint again
    // with the new strategy — which must now return a real winner.
    it('same candidate set: manual returns null, fastest returns the fastest', () => {
      const candidates = [c('stale', healthy(800, 0)), c('fresh', healthy(20, 0))];
      expect(pickEndpoint(candidates, 'manual')).toBeNull();
      const picked = pickEndpoint(candidates, 'fastest');
      expect(picked?.preset.id).toBe('fresh');
      expect(picked?.preset.url).toBe('https://fresh.example');
    });
  });
});
