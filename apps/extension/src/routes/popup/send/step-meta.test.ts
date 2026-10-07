import { describe, expect, it } from 'vitest';
import { stepMeta } from './send-ui';

describe('the header counter only counts up', () => {
  it.each([false, true])('device %s: form, review, sign', device => {
    const steps = (['form', 'review', ...(device ? ['sign'] : [])] as const).map(s =>
      Number(stepMeta(s, device).split(' / ')[0]),
    );
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps.map(String)).size).toBe(steps.length);
    expect(stepMeta(device ? 'sign' : 'review', device)).toBe(device ? '3 / 3' : '2 / 2');
  });
});
