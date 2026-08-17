import { describe, expect, it } from 'vitest';
import { assessRayonIsolation } from './rayon-isolation';

describe('assessRayonIsolation', () => {
  it('reports ok when isolated and SharedArrayBuffer is available', () => {
    const result = assessRayonIsolation({
      crossOriginIsolated: true,
      hasSharedArrayBuffer: true,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('reports degraded when crossOriginIsolated is false', () => {
    const result = assessRayonIsolation({
      crossOriginIsolated: false,
      hasSharedArrayBuffer: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/crossOriginIsolated/);
  });

  it('reports degraded when SharedArrayBuffer is undefined', () => {
    const result = assessRayonIsolation({
      crossOriginIsolated: true,
      hasSharedArrayBuffer: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SharedArrayBuffer/);
  });

  it('reports degraded (SharedArrayBuffer takes priority) when both are missing', () => {
    const result = assessRayonIsolation({
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SharedArrayBuffer/);
  });
});
