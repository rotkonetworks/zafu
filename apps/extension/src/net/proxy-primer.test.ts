// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { primeIn, primerUrl } from './proxy-primer';

describe('the proxy login primer', () => {
  it('loads one sandboxed, hidden frame on a zafu host, then removes it', async () => {
    const done = primeIn(document, primerUrl('zcash.rotko.net'), 50);
    const frame = document.querySelector('iframe')!;
    expect(frame.src).toBe('https://zcash.rotko.net/zafu-proxy-check');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.style.display).toBe('none');
    frame.dispatchEvent(new Event('load'));
    await done;
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('gives up after its time, and still removes the frame', async () => {
    await primeIn(document, primerUrl('zcash.rotko.net'), 10);
    expect(document.querySelector('iframe')).toBeNull();
  });
});
