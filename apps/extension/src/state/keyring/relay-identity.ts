/**
 * relay-identity — this device's identity on a frostd relay.
 *
 * A relay identity is NOT a wallet key and is deliberately unrelated to one.
 * It exists only to authenticate to the relay and to key the Noise_K sessions
 * that keep the relay from reading anything. Losing it costs you a session,
 * not funds; leaking it lets someone impersonate you to a relay that already
 * holds nothing but ciphertext.
 *
 * It is generated per multisig group rather than once per device. Reusing one
 * identity across groups would let a relay operator - or anyone watching -
 * link your sessions together, which is exactly the correlation a privacy
 * wallet should not hand out for free.
 *
 * WHY YOU MUST EXCHANGE KEYS BEFORE A SESSION EXISTS
 *
 * frostd lists a session's participants at creation and admits nobody else.
 * The old room-code flow discovered participants as they arrived; this cannot.
 * The trade is deliberate: a three-word code out of a 256-word list is around
 * 2^24 guesses, and anyone who landed on one could previously join a DKG as a
 * participant. Now an unlisted key cannot send or receive at all.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import type { RelayCipher, RelayIdentity } from './frostd-relay-client';

/** What we persist. The private key never leaves this device. */
export interface StoredRelayIdentity {
  privateKey: string;
  publicKey: string;
}

/** The subset of the wasm bundle this module needs. */
interface RelayWasm {
  frost_relay_generate_keypair(): string;
  frost_relay_sign_challenge(privateKeyHex: string, challenge: string): string;
  FrostRelayCipher: new (privateKeyHex: string, peersJson: string) => RelayCipher;
}

let wasm: RelayWasm | null = null;

/** Load the wasm bundle, the same way the rest of the extension does. */
async function loadWasm(): Promise<RelayWasm> {
  if (wasm !== null) {
    return wasm;
  }
  // The specifier is built at runtime on purpose. A literal here is
  // statically analyzable, and vite then tries to resolve a file that lives
  // in public/ and is only ever served, never bundled - which fails the test
  // run even though the extension itself is fine.
  const specifier = '/zafu-wasm/zafu_wasm.js';
  const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as RelayWasm;
  wasm = mod;
  return wasm;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Get this device's relay identity for a group, creating one on first use.
 *
 * `groupId` scopes the identity. Any stable string for the multisig group
 * will do; what matters is that different groups get different keys.
 */
export async function getOrCreateRelayIdentity(groupId: string): Promise<StoredRelayIdentity> {
  const all = (await localExtStorage.get('frostRelayIdentities')) ?? {};
  const existing = all[groupId];
  if (existing !== undefined) {
    return existing;
  }

  const w = await loadWasm();
  const generated = JSON.parse(w.frost_relay_generate_keypair()) as {
    private: string;
    public: string;
  };
  const identity: StoredRelayIdentity = {
    privateKey: generated.private,
    publicKey: generated.public,
  };
  await localExtStorage.set('frostRelayIdentities', { ...all, [groupId]: identity });
  return identity;
}

/** Forget a group's identity. Ends any session it could still authenticate. */
export async function forgetRelayIdentity(groupId: string): Promise<void> {
  const all = (await localExtStorage.get('frostRelayIdentities')) ?? {};
  const { [groupId]: _dropped, ...rest } = all;
  await localExtStorage.set('frostRelayIdentities', rest);
}

/**
 * Build the object FrostdRelayClient needs: our key, a challenge signer, and
 * Noise_K sessions against every peer.
 *
 * The cipher is stateful - the first message to a peer carries the handshake
 * and later ones run in transport mode - so one of these must live for the
 * whole session. Building a second one mid-session decrypts nothing.
 */
export async function buildRelayIdentity(
  stored: StoredRelayIdentity,
  peerPublicKeys: string[],
): Promise<RelayIdentity> {
  const w = await loadWasm();
  const cipher = new w.FrostRelayCipher(stored.privateKey, JSON.stringify(peerPublicKeys));

  return {
    publicKey: stored.publicKey,
    peers: peerPublicKeys,
    cipher,
    sign: async (challenge: string) =>
      hexToBytes(w.frost_relay_sign_challenge(stored.privateKey, challenge)),
  };
}
