import { describe, expect, it } from 'vitest';
import { escapeOmniboxXml, omniboxDescription, omniboxUri, parseOmnibox } from './omnibox';

describe('omniboxUri', () => {
  it('passes a scheme straight through', () => {
    expect(omniboxUri('zafu:open/receive')).toBe('zafu:open/receive');
    expect(omniboxUri('zcash:t1example')).toBe('zcash:t1example');
    expect(omniboxUri('https://zafu.pro/j#code')).toBe('https://zafu.pro/j#code');
  });

  it('adds the zafu: scheme to a bare intent', () => {
    expect(omniboxUri('open/receive')).toBe('zafu:open/receive');
    expect(omniboxUri('swap?from=eth&to=zec&amount=1')).toBe('zafu:swap?from=eth&to=zec&amount=1');
  });

  it('trims surrounding space', () => {
    expect(omniboxUri('  open/receive  ')).toBe('zafu:open/receive');
  });
});

describe('parseOmnibox', () => {
  it('reads a bare intent through the same router as a clicked link', () => {
    const r = parseOmnibox('swap?from=eth&to=zec&amount=1');
    expect(r).toEqual({
      ok: true,
      intent: { kind: 'swap', swap: { direction: 'into_zec', token: 'eth', amount: '1' } },
    });
  });

  it('reads a bare screen path', () => {
    expect(parseOmnibox('open/receive')).toEqual({
      ok: true,
      intent: { kind: 'screen', screen: 'receive' },
    });
  });

  it('reads a zcash: payment uri unchanged', () => {
    const r = parseOmnibox('zcash:t1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf?amount=1');
    expect(r.ok).toBe(true);
  });

  it('refuses what the router refuses', () => {
    expect(parseOmnibox('sign?tx=00')).toEqual({
      ok: false,
      reason: "zafu doesn't know this kind of link yet",
    });
  });
});

describe('omniboxDescription', () => {
  it('invites typing when empty', () => {
    expect(omniboxDescription('')).toBe('open zafu');
    expect(omniboxDescription('   ')).toBe('open zafu');
  });

  it('describes a swap', () => {
    expect(omniboxDescription('swap?from=eth&to=zec')).toBe('swap eth into zec');
  });

  it('describes a screen', () => {
    expect(omniboxDescription('open/receive')).toBe('open receive');
  });

  it('refuses calmly for malformed input', () => {
    expect(omniboxDescription('open/not-a-real-screen')).toMatch(/^not sure what to open/);
    expect(omniboxDescription('join/not-a-code')).toMatch(/^not sure what to open/);
  });

  it('answers what is not ready with the same calm line as a clicked link', () => {
    expect(omniboxDescription('swap?from=zec&to=btc&xc=penumbra')).toBe(
      "penumbra's dex doesn't trade zec · thorchain or near intents can, if you like",
    );
  });
});

describe('escapeOmniboxXml', () => {
  it('escapes the characters chrome parses as markup', () => {
    expect(escapeOmniboxXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeOmniboxXml('swap eth into zec')).toBe('swap eth into zec');
  });
});
