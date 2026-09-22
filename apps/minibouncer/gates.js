/**
 * The gates a bouncer applies, in one place so both runtimes apply the same ones:
 * `worker.js` (Cloudflare) and `serve.mjs` (your own server) import these rather
 * than each carrying a copy that drifts.
 */

/** the bearer token a request presented, if any. */
export const bearer = headerValue => {
  if (headerValue === null) {
    return null;
  }
  const prefix = 'Bearer ';
  return headerValue.startsWith(prefix) ? headerValue.slice(prefix.length) : null;
};

/** compare without an early exit, so a wrong token cannot be probed byte by byte. */
export const sameToken = (a, b) => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/** browser origins allowed to use this bouncer (empty = any). */
export const allowedOrigins = env =>
  (env.BOUNCER_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(o => o !== '');

/** the cookie a browser client carries into its WebSocket handshake. */
export const TOKEN_COOKIE = 'bouncer_token';

/** CORS headers for responses this bouncer answers itself. */
export const corsHeaders = (request, env) => {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins(env);
  const value = allowed.length > 0 ? (origin ?? allowed[0]) : (origin ?? '*');
  return {
    'access-control-allow-origin': value,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
};

export const refused = (request, env, status, message) =>
  new Response(`bouncer: ${message}`, { status, headers: corsHeaders(request, env) });

/** the friendly token a request presented: header, `?token=`, or cookie. */
export const presentedToken = (request, url) => {
  const header = bearer(request.headers.get('authorization'));
  if (header !== null) {
    return header;
  }
  const query = url.searchParams.get('token');
  if (query !== null && query !== '') {
    return query;
  }
  const cookies = request.headers.get('cookie');
  if (cookies === null) {
    return null;
  }
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === TOKEN_COOKIE) {
      return rest.join('=');
    }
  }
  return null;
};

/** the friend tokens this bouncer accepts (empty = open, which only makes sense locally). */
export const friendTokens = env =>
  (env.BOUNCER_TOKENS ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(t => t !== '');

/**
 * Credentials for the upstream hop, kept separate from the inbound ones:
 * the friend's token proves membership HERE and must not travel to the relay;
 * the relay's token (if it has one) is added here and is never seen by friends.
 */
export const upstreamHeaders = (headers, env) => {
  const out = new Headers(headers);
  const relayToken = env.RELAY_TOKEN;
  if (relayToken !== undefined && relayToken !== '') {
    out.set('authorization', `Bearer ${relayToken}`);
  } else {
    out.delete('authorization');
  }
  return out;
};
