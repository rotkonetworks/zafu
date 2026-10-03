import { describe, expect, it } from 'vitest';
import { rpIdMatchesOrigin } from './public-suffix';

describe('rpIdMatchesOrigin', () => {
  it('accepts the host and a registrable parent', () => {
    expect(rpIdMatchesOrigin('example.com', 'https://example.com')).toBe(true);
    expect(rpIdMatchesOrigin('example.com', 'https://login.example.com')).toBe(true);
    expect(rpIdMatchesOrigin('example.co.uk', 'https://www.example.co.uk')).toBe(true);
    expect(rpIdMatchesOrigin('me.github.io', 'https://me.github.io')).toBe(true);
  });

  it('refuses a public suffix, so a subdomain cannot sign for an unrelated parent', () => {
    expect(rpIdMatchesOrigin('com', 'https://evil.com')).toBe(false);
    expect(rpIdMatchesOrigin('co.uk', 'https://evil.co.uk')).toBe(false);
    expect(rpIdMatchesOrigin('com.au', 'https://evil.com.au')).toBe(false);
    expect(rpIdMatchesOrigin('github.io', 'https://a.github.io')).toBe(false);
    expect(rpIdMatchesOrigin('vercel.app', 'https://a.vercel.app')).toBe(false);
  });

  it('refuses another site, a lookalike suffix, an IP parent and a malformed rpId', () => {
    expect(rpIdMatchesOrigin('example.com', 'https://evil.com')).toBe(false);
    expect(rpIdMatchesOrigin('example.com', 'https://notexample.com')).toBe(false);
    expect(rpIdMatchesOrigin('0.0.1', 'http://127.0.0.1')).toBe(false);
    expect(rpIdMatchesOrigin('Example.com', 'https://example.com')).toBe(false);
    expect(rpIdMatchesOrigin('', 'https://example.com')).toBe(false);
  });
});
