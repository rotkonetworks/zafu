import { afterEach, describe, expect, it } from 'vitest';
import { silenceSessionClientNoise } from './session-client-noise';

const originalWarn = console.warn;
const originalError = console.error;
const originalDev = globalThis.__DEV__;

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  globalThis.__DEV__ = originalDev;
});

describe('silenceSessionClientNoise', () => {
  it('drops the transport noise lines and keeps everything else', () => {
    globalThis.__DEV__ = true;
    const warns: unknown[][] = [];
    const errors: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warns.push(args);
    console.error = (...args: unknown[]) => void errors.push(args);

    silenceSessionClientNoise();

    console.warn('session-client reportError', 'request-id', { error: 'x' });
    console.warn('session-client signal', 'name', new Error('Extension context invalidated'));
    console.warn('some real warning');
    console.error('session-client connect error', new Error('Extension context invalidated'));
    console.error('some real error');

    expect(warns).toEqual([['some real warning']]);
    expect(errors).toEqual([['some real error']]);
  });

  it('is a no-op in a production build', () => {
    globalThis.__DEV__ = false;
    const warns: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warns.push(args);

    silenceSessionClientNoise();
    console.warn('session-client reportError', 'request-id');

    expect(warns).toEqual([['session-client reportError', 'request-id']]);
  });
});
