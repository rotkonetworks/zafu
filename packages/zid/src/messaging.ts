/**
 * zid feature-detection and post-quantum messaging over the wallet.
 *
 * `detect()` lets a dapp decide what to render (install CTA / login button /
 * "update your wallet") before doing anything. `encryptFor` / `decryptFrom`
 * route through the wallet's zafu_encrypt / zafu_decrypt and AUTOMATICALLY use
 * the recipient's post-quantum key when the wallet advertises one, so an SDK
 * dapp gets harvest-now-decrypt-later protection for free. All of these throw a
 * typed ZafuError instead of returning null, so a caller can branch on why.
 */

import {
  ZAFU_PROTOCOL_VERSION,
  isZafuError,
  type ZafuMethod,
  type ZafuRequest,
  type ZafuResponse,
} from '@zafu/protocol';
import { detectZafu } from './provider';
import { createExtensionTransport, type ZafuHandle } from './transport';
import { ZafuError, classifyWalletError } from './errors';

// -- base64 (browser btoa/atob; avoids a Buffer dependency) --
const b64encode = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const b64decode = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// -- hex (lowercase, no 0x; matches @zafu/protocol Hex) --
const hexencode = (b: Uint8Array): string =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** what a wallet-detection probe found. */
export interface ZafuDetection {
  /** a zafu wallet is reachable. */
  installed: boolean;
  /** the wallet's own release version (when installed). */
  walletVersion?: string;
  /** the highest wire-protocol major the wallet speaks. */
  protocolVersion?: number;
  /** every protocol major the wallet supports (QUIC-style negotiation). */
  protocolVersions?: number[];
  /** the wallet supports the protocol major THIS SDK speaks. */
  compatible?: boolean;
}

/** a recipient's advertised keys, from `zidPubkey`. */
export interface ZidRecipient {
  /** site-scoped ed25519 pubkey (hex) - classical sealed box. */
  pubkey: string;
  /** site-scoped post-quantum sealed-box pubkey (hex), when advertised. */
  pq_pubkey?: string;
  /** the suite of pq_pubkey (e.g. 'xwing-v1'). */
  pq_suite?: string;
}

/** unwrap a wallet response: throw a typed error, or return the success value. */
async function call<M extends ZafuMethod>(
  handle: ZafuHandle,
  method: M,
  req: ZafuRequest<M>,
): Promise<Exclude<ZafuResponse<M>, { error: string }>> {
  let resp: ZafuResponse<M>;
  try {
    resp = await createExtensionTransport(handle).request(method, req);
  } catch (e) {
    throw new ZafuError('transport_error', e instanceof Error ? e.message : String(e));
  }
  if (isZafuError(resp)) {
    throw classifyWalletError(resp.error, (resp as { code?: string }).code);
  }
  // some methods answer { success: false, error } instead of { error }
  if (typeof resp === 'object' && resp !== null && 'success' in resp && !resp.success) {
    const r = resp as { error?: string; code?: string };
    throw classifyWalletError(r.error, r.code);
  }
  // zafu_request_capability answers { granted: false, capability } - a refusal,
  // not a success. Treat it as a denied error rather than returning it as a value.
  if (
    typeof resp === 'object' &&
    resp !== null &&
    'granted' in resp &&
    (resp as { granted?: unknown }).granted !== true
  ) {
    const cap = (resp as { capability?: string }).capability;
    throw new ZafuError('denied', `capability not granted${cap ? `: ${cap}` : ''}`);
  }
  return resp as Exclude<ZafuResponse<M>, { error: string }>;
}

/**
 * Probe for a zafu wallet and negotiate the protocol version. Never throws -
 * returns `{ installed: false }` when nothing is reachable. Use it to decide
 * whether to show a "login with zafu" affordance.
 */
export async function detect(zafu?: ZafuHandle | null): Promise<ZafuDetection> {
  const handle = zafu ?? (await detectZafu());
  if (!handle) {
    return { installed: false };
  }
  try {
    const pong = await createExtensionTransport(handle).request('ping', { type: 'ping' });
    if (isZafuError(pong) || !('zafu' in pong)) {
      return { installed: false };
    }
    const protocolVersions = pong.protocolVersions ?? [pong.protocolVersion];
    return {
      installed: true,
      walletVersion: pong.version,
      protocolVersion: pong.protocolVersion,
      protocolVersions,
      compatible: protocolVersions.includes(ZAFU_PROTOCOL_VERSION),
    };
  } catch {
    return { installed: false };
  }
}

/**
 * Resolve a reachable, protocol-compatible wallet handle, or throw a typed
 * ZafuError explaining why not: `unavailable` (no wallet), or `incompatible`
 * (a wallet is present but speaks no protocol major this SDK understands). Use
 * it before the messaging helpers when you want that distinction surfaced as an
 * error rather than reading the `detect()` struct yourself.
 */
export async function requireWallet(zafu?: ZafuHandle | null): Promise<ZafuHandle> {
  const handle = zafu ?? (await detectZafu());
  // resolve the handle first so we don't probe twice (detect(null) would re-run
  // detectZafu). Once we have a handle, detect() confirms it and reads the version.
  if (!handle) {
    throw new ZafuError('unavailable', 'no zafu wallet reachable');
  }
  const d = await detect(handle);
  if (!d.installed) {
    throw new ZafuError('unavailable', 'no zafu wallet reachable');
  }
  if (d.compatible === false) {
    throw new ZafuError(
      'incompatible',
      `wallet speaks protocol ${(d.protocolVersions ?? []).join(', ') || '?'}, this SDK speaks ${ZAFU_PROTOCOL_VERSION}`,
    );
  }
  return handle;
}

/** an ed25519 signature from the caller's site-scoped ZID key. */
export interface ZidSignature {
  /** ed25519 signature over the challenge, hex. */
  signature: string;
  /** the site-scoped ZID ed25519 public key that signed, hex. */
  publicKey: string;
}

/**
 * Sign a challenge with the site-scoped ZID ed25519 key - the "login with zafu"
 * primitive. Classical ed25519 by design: a signature has no
 * harvest-now-decrypt-later exposure (you cannot retroactively forge one that
 * already verified), so it needs no post-quantum treatment and interoperates
 * with any ed25519 verifier. Throws a typed ZafuError (`denied`, `locked`, ...)
 * instead of returning null.
 *
 * SECURITY: the signature covers ONLY `challengeHex`. The wallet shows the
 * calling origin but does NOT bind it into the signed bytes, so a relying party
 * MUST make the challenge unforgeable and non-replayable itself - sign a fresh
 * server-issued nonce that also commits to the origin/audience (SIWE-style),
 * never a static string. A signature over challenge C is valid at any site that
 * presents the same C.
 */
export async function sign(
  zafu: ZafuHandle,
  challengeHex: string,
  statement?: string,
): Promise<ZidSignature> {
  const resp = await call(zafu, 'zafu_sign', { type: 'zafu_sign', challengeHex, statement });
  if (!resp.signature || !resp.publicKey) {
    throw new ZafuError('wallet_error', 'sign: wallet returned no signature');
  }
  return { signature: resp.signature, publicKey: resp.publicKey };
}

/** As `sign`, but hex-encodes raw message bytes for you. */
export async function signBytes(
  zafu: ZafuHandle,
  message: Uint8Array,
  statement?: string,
): Promise<ZidSignature> {
  return sign(zafu, hexencode(message), statement);
}

/** fetch a recipient's advertised keys (the site-scoped ZID pubkeys). */
export async function zidPubkey(zafu: ZafuHandle): Promise<ZidRecipient> {
  const resp = (await call(zafu, 'zafu_zid_pubkey', {
    type: 'zafu_zid_pubkey',
  }));
  return { pubkey: resp.pubkey, pq_pubkey: resp.pq_pubkey, pq_suite: resp.pq_suite };
}

/**
 * Encrypt `plaintext` to a recipient. Uses the post-quantum sealed box whenever
 * the recipient advertises `pq_pubkey` (harvest-now-decrypt-later resistant),
 * falling back to the classical sealed box otherwise. Returns the sealed
 * ciphertext plus the ephemeral pubkey the recipient needs to open it (empty for
 * the post-quantum path, where the ephemeral is inside the ciphertext).
 *
 * Pass `{ requirePq: true }` to fail closed when the post-quantum path was NOT
 * used (recipient has no PQ key, or the sender's wallet predates it) instead of
 * silently sending classical - for callers that must not emit
 * harvest-now-decrypt-later-vulnerable ciphertext.
 */
export async function encryptFor(
  zafu: ZafuHandle,
  recipient: ZidRecipient,
  plaintext: Uint8Array,
  opts?: { requirePq?: boolean },
): Promise<{ ciphertext: string; ephemeral_pubkey: string; postQuantum: boolean }> {
  const pt = b64encode(plaintext);
  const req = recipient.pq_pubkey
    ? ({
        type: 'zafu_encrypt' as const,
        recipient: recipient.pubkey,
        recipient_pq: recipient.pq_pubkey,
        plaintext: pt,
      })
    : ({ type: 'zafu_encrypt' as const, recipient: recipient.pubkey, plaintext: pt });
  const resp = await call(zafu, 'zafu_encrypt', req);
  // postQuantum reflects the ACTUAL outcome, not the intent: the hybrid path
  // carries its ephemeral inside the ciphertext and returns an empty
  // ephemeral_pubkey; the classical path returns the sender's ephemeral pubkey.
  // (Boolean(recipient.pq_pubkey) would report a false positive when the sender's
  // own wallet is too old to honour the PQ path.)
  const postQuantum = resp.ephemeral_pubkey === '';
  if (opts?.requirePq && !postQuantum) {
    throw new ZafuError(
      'not_available',
      'requirePq: the wallet did not use the post-quantum path (recipient has no PQ key, or the wallet predates it)',
    );
  }
  return {
    ciphertext: resp.ciphertext,
    ephemeral_pubkey: resp.ephemeral_pubkey,
    postQuantum,
  };
}

/**
 * Decrypt a sealed box addressed to the caller's own site key. Pass the
 * `ciphertext` and `ephemeral_pubkey` from `encryptFor` (an empty
 * `ephemeral_pubkey` selects the post-quantum path). Returns the plaintext bytes.
 */
export async function decryptFrom(
  zafu: ZafuHandle,
  sealed: { ciphertext: string; ephemeral_pubkey: string },
): Promise<Uint8Array> {
  const resp = (await call(zafu, 'zafu_decrypt', {
    type: 'zafu_decrypt',
    ciphertext: sealed.ciphertext,
    ephemeral_pubkey: sealed.ephemeral_pubkey,
  }));
  return b64decode(resp.plaintext);
}
