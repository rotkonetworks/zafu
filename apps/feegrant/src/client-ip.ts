/**
 * The client IP used for per-IP limits.
 *
 * Behind our own reverse proxy (TRUST_PROXY=1) the real client address is the
 * LAST X-Forwarded-For entry: HAProxy's `option forwardfor` appends the peer it
 * actually saw after whatever the client itself sent. Taking the FIRST entry
 * would let anyone pick their own "IP" with a forged header and rotate it per
 * request to dodge the limits. Without a trusted proxy the socket address is
 * the only honest value.
 */
export const clientIpFrom = (
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string => {
  if (trustProxy && forwardedFor !== undefined) {
    // node joins repeated headers with ", "; an array can also appear
    const joined = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
    const last = joined
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .pop();
    if (last) {
      return last;
    }
  }
  return remoteAddress ?? 'unknown';
};
