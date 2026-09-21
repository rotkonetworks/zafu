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
 * - `'auto'` - try hybrid, and fall back to classical ONLY when the HANDSHAKE
 *   itself failed (see below). A transport failure - relay down, socket error, a
 *   peer that never answers - PROPAGATES: it is not a downgrade trigger, because
 *   an outage must not be misread as "this peer is not post-quantum capable".
 *
 * INTEROP: `@zafu/zid@0.1.0` speaks only the classical handshake, and the hybrid
 * protocol name is deliberately distinct so a mixed pair FAILS rather than
 * negotiating a weaker key. A default (`'hybrid'`) caller therefore cannot open a
 * channel to a 0.1.0 peer - pass `'classical'` to reach one, or `'auto'` to
 * accept a downgrade knowingly. `'auto'` is the only path that falls back, it is
 * never the default, and it is never implicit.
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
  // 'auto': the caller has explicitly accepted a downgrade - but only for a
  // failed handshake. Anything else (relay down, socket error) is rethrown.
  try {
    return withKind(await createNoiseChannel(session, peerPubkey, relayUrl), 'hybrid');
  } catch (e) {
    if (!isNoiseHandshakeFailure(e)) {
      throw e;
    }
    return withKind(await createChannel(session, peerPubkey, relayUrl), 'classical');
  }
}
