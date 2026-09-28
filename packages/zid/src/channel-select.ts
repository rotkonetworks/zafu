/**
 * Which handshake a channel uses, and the one place that decision is made.
 *
 * The mode is a CALLER decision (`zid.connect({ channel })`), not a heuristic on
 * the peer: the guest and the wallet path both pass the same option here, so
 * there is exactly one rule and no special case buried in either identity.
 *
 * - `'hybrid'` (default) - the post-quantum Noise IK handshake
 *   (./noise-channel: X25519 + ML-KEM-768). It fails CLOSED against a peer that
 *   cannot do it; there is no downgrade.
 * - `'classical'` - the legacy X25519 + AES-GCM handshake (./channel).
 * - `'auto'` - try hybrid, and fall back to classical ONLY on a genuine
 *   handshake-CAPABILITY signal: a well-formed protocol refusal in which the
 *   peer names the protocol it speaks instead of the hybrid one. A malformed or
 *   truncated frame, an AEAD/decapsulation failure, a peer-key mismatch, a relay
 *   down, a socket error or the handshake deadline all PROPAGATE: a hostile relay
 *   must not be able to force a post-quantum -> classical downgrade with one
 *   crafted frame, and an outage must not be misread as "this peer is not
 *   post-quantum capable".
 *
 * INTEROP: `@zafu/zid@0.1.0` speaks only the classical handshake, and the hybrid
 * protocol name is deliberately distinct so a mixed pair FAILS rather than
 * negotiating a weaker key. Pass `'classical'` to reach a 0.1.0 peer: it parses
 * only JSON `keyex` frames and drops a binary hybrid init, and it never sends a
 * refusal, so a hybrid attempt against it ends in the readiness deadline - which
 * `'auto'` RETHROWS rather than downgrading on (a timeout is not a capability
 * signal). `'auto'` therefore falls back only against a peer that implements the
 * refusal; it is never the default, and it is never implicit.
 */

import { createChannel } from './channel';
import { createNoiseChannel, isNoiseHandshakeFailure, type SessionKey } from './noise-channel';
import type { ChannelKind, ChannelMode, ZidChannel } from './types';

/** stamp the handshake that was actually used, so a caller can SEE a downgrade. */
const withKind = (channel: ZidChannel, kind: ChannelKind): ZidChannel =>
  Object.assign(channel, { kind });

/**
 * Open an e2ee channel to `peerPubkey` under `mode` (default `'hybrid'`).
 *
 * The returned channel carries `kind` - `'hybrid'` or `'classical'` - so an
 * `'auto'` caller can refuse, warn about, or record a downgrade.
 *
 * `session` must carry the ed25519 `privkey`: the hybrid handshake derives its
 * X25519 static key from it (edPrivToX), which a pubkey-only session cannot
 * supply. A session from `createSessionKey` does.
 */
export async function openChannel(
  session: SessionKey,
  peerPubkey: string,
  relayUrl: string | undefined,
  mode: ChannelMode = 'hybrid',
): Promise<ZidChannel> {
  if (mode === 'classical') {
    return withKind(await createChannel(session, peerPubkey, relayUrl), 'classical');
  }
  if (mode === 'hybrid') {
    return withKind(await createNoiseChannel(session, peerPubkey, relayUrl), 'hybrid');
  }
  // 'auto': the caller has explicitly accepted a downgrade - but ONLY on a
  // well-formed capability signal (isNoiseHandshakeFailure). Anything else -
  // malformed/short frame, AEAD failure, socket error, handshake deadline - is
  // rethrown so a hostile relay cannot force a downgrade with crafted bytes.
  try {
    return withKind(await createNoiseChannel(session, peerPubkey, relayUrl), 'hybrid');
  } catch (e) {
    if (!isNoiseHandshakeFailure(e)) {
      throw e;
    }
    return withKind(await createChannel(session, peerPubkey, relayUrl), 'classical');
  }
}
