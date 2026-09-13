/**
 * group-chat-crypto - sealing chat frames between two relay identities.
 *
 * WHY NOT THE RELAY'S OWN CIPHER
 *
 * The multisig transport (FrostRelayCipher) is Noise_K: a stateful handshake
 * then a nonce-sequenced transport stream. That is right for one bounded
 * signing ceremony and wrong for chat. The cipher object lives in the popup;
 * the popup is torn down every time it closes, so a co-signer who reopens the
 * thread has a fresh cipher that cannot read the transport stream a peer is
 * mid-way through - and chat has no fixed initiator to re-handshake around.
 * The relay queues messages for an absent member for up to a day, but with a
 * stateful cipher that returning member could never open them, which is the
 * whole reason the thread is worth having.
 *
 * So chat frames are sealed statelessly instead: a static-static x25519 DH
 * between the two relay identities, HKDF to an AES-256-GCM key, one random
 * nonce per message. Nothing to keep between messages, nothing to lose when
 * the popup closes, and reordering does not matter.
 *
 * AUTHORSHIP
 *
 * The relay is untrusted and can lie about a message's `sender`, so we do not
 * trust that field for authorship. The pair key can only be derived by the
 * holder of one of the two identities' private keys, so a frame that opens
 * under peer P's key was written by P. `sender` is used only as a hint for
 * which peer key to try first. The session id is folded into the key so a
 * frame cannot be replayed into a different chat session.
 *
 * The same static pair key is reused across a session's messages (no forward
 * secrecy); the 96-bit random GCM nonce per message keeps that safe at chat
 * volumes. A future hardening (shared with the ZID mailbox work) can ratchet.
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { aesGcmEncrypt, aesGcmDecrypt } from '../../crypto/aes-gcm';

/**
 * The HKDF info that pins a pair key to this pair and this chat session.
 *
 * static-static DH is symmetric - x25519(a_priv, b_pub) == x25519(b_priv,
 * a_pub) - so both ends must feed HKDF the identical info to land on the same
 * key. The two public keys are sorted so the string does not depend on who is
 * sealing and who is opening.
 */
const pairInfo = (aPubHex: string, bPubHex: string, sessionId: string): Uint8Array => {
  const [lo, hi] = [aPubHex.toLowerCase(), bPubHex.toLowerCase()].sort();
  return new TextEncoder().encode(`zafu-groupchat-v1:${lo}:${hi}:${sessionId}`);
};

const pairKey = (myPrivHex: string, peerPubHex: string, sessionId: string): Uint8Array => {
  const shared = x25519.getSharedSecret(hexToBytes(myPrivHex), hexToBytes(peerPubHex));
  const myPubHex = bytesToHex(x25519.getPublicKey(hexToBytes(myPrivHex)));
  const key = hkdf(sha256, shared, undefined, pairInfo(myPubHex, peerPubHex, sessionId), 32);
  shared.fill(0);
  return key;
};

/** Seal `plaintext` to `peerPubHex` for chat session `sessionId`. Returns hex. */
export const sealChatFrame = async (
  myPrivHex: string,
  peerPubHex: string,
  sessionId: string,
  plaintext: Uint8Array,
): Promise<string> => {
  const key = pairKey(myPrivHex, peerPubHex, sessionId);
  const sealed = await aesGcmEncrypt(key, plaintext);
  key.fill(0);
  return bytesToHex(sealed);
};

/**
 * Open a frame from `senderPubHex`. Throws if it was not sealed by the holder
 * of `senderPubHex`'s private key for this session - so a successful return is
 * proof of authorship, not the relay's say-so.
 */
export const openChatFrame = async (
  myPrivHex: string,
  senderPubHex: string,
  sessionId: string,
  sealedHex: string,
): Promise<Uint8Array> => {
  const key = pairKey(myPrivHex, senderPubHex, sessionId);
  const plaintext = await aesGcmDecrypt(key, hexToBytes(sealedHex));
  key.fill(0);
  return plaintext;
};
