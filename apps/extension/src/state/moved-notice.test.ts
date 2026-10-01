import { describe, expect, it } from 'vitest';
import { showMoved } from './moved-notice';

describe('showMoved', () => {
  it('tells someone coming from the old layout', () => {
    expect(showMoved('28.3.1')).toBe(true);
    expect(showMoved('27.9.12')).toBe(true);
  });

  it('stays quiet once seen, on a fresh install, or with nothing stamped', () => {
    expect(showMoved('28.3.2')).toBe(false);
    expect(showMoved('28.10.0')).toBe(false);
    expect(showMoved('29.0.0')).toBe(false);
    expect(showMoved(undefined)).toBe(false);
  });
});
