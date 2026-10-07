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

  it.each([
    ['myshopify.com', 'https://evil.myshopify.com'],
    ['eth.limo', 'https://evil.eth.limo'],
    ['dweb.link', 'https://bafyevil.ipfs.dweb.link'],
    ['ipfs.dweb.link', 'https://bafyevil.ipfs.dweb.link'],
    ['wixsite.com', 'https://evil.wixsite.com'],
    ['webflow.io', 'https://evil.webflow.io'],
    ['blogspot.com', 'https://evil.blogspot.com'],
    ['eth.link', 'https://evil.eth.link'],
    ['pvt.k12.ma.us', 'https://evil.pvt.k12.ma.us'],
  ])('refuses %s from %s: the full list, private section included', (rpId, origin) => {
    expect(rpIdMatchesOrigin(rpId, origin)).toBe(false);
  });

  it.each([
    ['shop.myshopify.com', 'https://login.shop.myshopify.com'],
    ['vitalik.eth.limo', 'https://app.vitalik.eth.limo'],
    ['bbc.co.uk', 'https://account.bbc.co.uk'],
    ['github.com', 'https://gist.github.com'],
    ['webauthn.io', 'https://webauthn.io'],
    ['z.cash', 'https://forum.z.cash'],
  ])('still accepts registrable %s from %s', (rpId, origin) => {
    expect(rpIdMatchesOrigin(rpId, origin)).toBe(true);
  });

  it('follows the list where it has moved on: retired blogspot country domains are ordinary', () => {
    // Google retired blogspot.co.uk and friends (they redirect to blogspot.com)
    // and the list dropped them; the browser's own rpId check agrees
    expect(rpIdMatchesOrigin('blogspot.co.uk', 'https://evil.blogspot.co.uk')).toBe(true);
  });

  it('refuses a port, an uppercase or unicode rpId, and an IP parent', () => {
    expect(rpIdMatchesOrigin('example.com:443', 'https://example.com')).toBe(false);
    expect(rpIdMatchesOrigin('EXAMPLE.com', 'https://login.example.com')).toBe(false);
    expect(rpIdMatchesOrigin('bücher.de', 'https://www.bücher.de')).toBe(false);
    expect(rpIdMatchesOrigin('0.1', 'https://10.0.0.1')).toBe(false);
    expect(rpIdMatchesOrigin('example.com.', 'https://login.example.com')).toBe(false);
  });

  it('refuses another site, a lookalike suffix, an IP parent and a malformed rpId', () => {
    expect(rpIdMatchesOrigin('example.com', 'https://evil.com')).toBe(false);
    expect(rpIdMatchesOrigin('example.com', 'https://notexample.com')).toBe(false);
    expect(rpIdMatchesOrigin('0.0.1', 'http://127.0.0.1')).toBe(false);
    expect(rpIdMatchesOrigin('Example.com', 'https://example.com')).toBe(false);
    expect(rpIdMatchesOrigin('', 'https://example.com')).toBe(false);
  });
});
