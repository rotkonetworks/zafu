#!/usr/bin/env node
/**
 * Hand someone your bouncer.
 *
 * A bouncer is most useful run for a few people who trust you with their address,
 * and the only thing they need from you is a URL and (if you gated it) a token.
 * This prints both, twice over: once for a wallet's settings fields, once as the
 * code an app pastes into its own connect() call.
 *
 *   node invite.mjs --url https://bouncer.example --new --name alice
 *
 * `--new` mints a fresh token with a name, so you can give each person their own
 * and revoke one without rotating everybody's. Keep the whole set in the
 * BOUNCER_TOKENS secret (comma-separated):
 *
 *   wrangler secret put BOUNCER_TOKENS     # alice:... , bob:...
 *
 * Without `--new` the script prints an invite for the URL as-is (an ungated
 * bouncer, or one whose tokens you manage yourself).
 */

import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const url = flag('url');
if (url === undefined || url === '') {
  console.error('usage: node invite.mjs --url https://your-bouncer.example [--new [--name alice]]');
  process.exit(1);
}

const parsed = (() => {
  try {
    return new URL(url);
  } catch {
    console.error(`invite: "${url}" is not a URL`);
    process.exit(1);
  }
})();

const channelUrl = `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}/ws/zid`;
const token = args.includes('--new')
  ? `${flag('name') ?? 'friend'}:${randomBytes(18).toString('base64url')}`
  : undefined;
// a named token is for BOUNCER_TOKENS; the part after the colon is what the friend sends
const friendToken = token === undefined ? undefined : token.slice(token.indexOf(':') + 1);

const line = (label, value) => console.log(`${label.padEnd(10)} ${value}`);

console.log(`\nbouncer    ${parsed.origin}`);
line('presence', parsed.origin);
line('channels', channelUrl);
if (token !== undefined) {
  line('token', friendToken);
  console.log(`\nadd to BOUNCER_TOKENS (wrangler secret put BOUNCER_TOKENS):\n  ${token}`);
} else {
  console.log('\n(no --new: this bouncer is ungated, or you manage its tokens yourself)');
}
console.log(`
for a wallet: settings -> private contact discovery
  endpoint   ${parsed.origin}
  token      ${friendToken ?? '(none)'}

for an app (browser or guest):

  const me = await zid.connect({
    relayEndpoint: '${parsed.origin}',
    relayUrl: '${channelUrl}',${friendToken === undefined ? '' : `\n    relayToken: '${friendToken}',`}
  });

what this asks of them: their address is visible to YOU and to no one past you - the
relay sees this bouncer's address for every one of your friends, so a relay's logs,
leaks or subpoenas cannot say who was talking. Content stays end-to-end encrypted
either way; the bouncer never holds a key. Log nothing, and the mapping never exists
anywhere to hand over.
`);
