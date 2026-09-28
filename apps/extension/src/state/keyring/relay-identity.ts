/**
 * relay-identity — this device's identity on a frostd relay.
 *
 * A relay identity is NOT a wallet key and is deliberately unrelated to one.
 * Its X25519 private key authenticates to the relay and keys the Noise_K
 * sessions that keep the relay from reading anything - but that is not its
 * only role. The same scalar is the static private half of the pairwise DH that
 * seals group-chat frames (see group-chat-crypto), so it is the group-chat
 * confidentiality key. Leaking it is therefore not "impersonation only": an
 * attacker who holds it can decrypt every group-chat message encrypted to that
 * identity, and impersonate the device to the relay besides. Losing it costs a
 * session and read access to history sealed to it, not funds.
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
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncryptedWithMigration, writeEncryptedDirect } from '../encrypted-storage';
import type { RelayCipher, RelayIdentity } from './frostd-relay-client';

/** What we persist. The private key never leaves this device. */
export interface StoredRelayIdentity {
  privateKey: string;
  publicKey: string;
}

type RelayIdentityMap = Record<string, StoredRelayIdentity>;

/** The subset of the wasm bundle this module needs. */
interface RelayWasm {
  frost_relay_generate_keypair(): string;
  frost_relay_sign_challenge(privateKeyHex: string, challenge: string): string;
  FrostRelayCipher: new (privateKeyHex: string, peersJson: string) => RelayCipher;
}

let wasm: RelayWasm | null = null;

/**
 * Load the wasm bundle, the same way the rest of the extension does.
 *
 * Importing the glue is not enough: until something calls its init, every
 * export dies with "reading '__wbindgen_free'". This used to work only when
 * some other screen had initialised the module first (the page shares one
 * module instance per URL), so opening a multisig room straight away broke.
 */
async function loadWasm(): Promise<RelayWasm> {
  if (wasm !== null) {
    return wasm;
  }
  // Initialise through the one page-realm initialiser (shared memory, panic
  // hook). A second init of the same module instance is a no-op, so this is
  // safe whichever screen gets there first.
  const { initZcashWasm } = await import('./zcash');
  await initZcashWasm();
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
 * Adding an identity is a read-modify-write over the whole `frostRelayIdentities`
 * map, and it awaits wasm key generation in between. Two concurrent calls for
 * different groups would otherwise both read the map before either writes, and
 * the second write would clobber the first group's entry - silently losing that
 * group's key (and with it its chat history). The queue re-reads the map
 * immediately before each write, so a late entry is merged, never overwritten.
 *
 * Reads go through the encrypted path (migrating a legacy plaintext value in
 * place): the private key is the group-chat confidentiality secret, so it is
 * sealed at rest like the messages it opens.
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * A group's relay identity could not be stored: the wallet is locked, so there
 * is no session key to seal it with and the write was skipped.
 *
 * It is thrown rather than papered over because the value being written is a
 * GENERATED key: returning it would hand the caller a relay identity that does
 * not exist on this device, and the next unlocked call would mint a DIFFERENT
 * key for the same group - silently rotating it and orphaning every chat frame
 * sealed to the original.
 */
export class RelayIdentityLockedError extends Error {
  constructor(groupId: string) {
    super(
      `relay identity for '${groupId}': wallet is locked, refusing to return a key that cannot be persisted`,
    );
    this.name = 'RelayIdentityLockedError';
  }
}

function updateRelayIdentities<T>(
  mutate: (all: RelayIdentityMap) => T,
  groupId: string,
): Promise<T> {
  const run = async (): Promise<T> => {
    const all =
      (await readEncryptedWithMigration<RelayIdentityMap>(
        localExtStorage,
        sessionExtStorage,
        'frostRelayIdentities',
      )) ?? {};
    const result = mutate(all);
    const persisted = await writeEncryptedDirect(
      localExtStorage,
      sessionExtStorage,
      'frostRelayIdentities',
      all,
    );
    if (!persisted) {
      throw new RelayIdentityLockedError(groupId);
    }
    return result;
  };
  const result = writeChain.then(run);
  // keep the chain alive past a failed write so one bad update cannot wedge it
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Get this device's relay identity for a group, creating one on first use.
 *
 * `groupId` scopes the identity. Any stable string for the multisig group
 * will do; what matters is that different groups get different keys.
 */
export async function getOrCreateRelayIdentity(groupId: string): Promise<StoredRelayIdentity> {
  const existing = ((await readEncryptedWithMigration<RelayIdentityMap>(
    localExtStorage,
    sessionExtStorage,
    'frostRelayIdentities',
  )) ?? {})[groupId];
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
  // Re-read and merge inside the serialised write: a concurrent call for a
  // different group may have added its entry since the read above.
  const all = await updateRelayIdentities(map => {
    if (map[groupId] === undefined) {
      map[groupId] = identity;
    }
    return map;
  }, groupId);
  return all[groupId]!;
}

/** Forget a group's identity. Ends any session it could still authenticate. */
export async function forgetRelayIdentity(groupId: string): Promise<void> {
  await updateRelayIdentities(map => {
    delete map[groupId];
  }, groupId);
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
