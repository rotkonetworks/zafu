import { describe, expect, it } from 'vitest';
import { clientIpFrom } from './client-ip';

describe('clientIpFrom', () => {
  it('uses the last X-Forwarded-For entry (the one our proxy appended)', () => {
    // client forged "1.2.3.4"; haproxy appended the real peer
    expect(clientIpFrom('1.2.3.4, 203.0.113.9', '127.0.0.1', true)).toBe('203.0.113.9');
  });

  it('handles repeated headers delivered as an array', () => {
    expect(clientIpFrom(['1.2.3.4', '203.0.113.9'], '127.0.0.1', true)).toBe('203.0.113.9');
  });

  it('ignores the header entirely without a trusted proxy', () => {
    expect(clientIpFrom('1.2.3.4', '198.51.100.7', false)).toBe('198.51.100.7');
  });

  it('falls back to the socket address when the header is empty', () => {
    expect(clientIpFrom('', '198.51.100.7', true)).toBe('198.51.100.7');
  });
});
