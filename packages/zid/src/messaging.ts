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

import { ZAFU_PROTOCOL_VERSION, isZafuError } from '@zafu/protocol';
import type {
  ZafuMethod,
  ZafuRequest,
  ZafuResponse,
  ZafuZidPubkeyResponse,
  ZafuEncryptResponse,
  ZafuDecryptResponse,
} from '@zafu/protocol';
import { detectZafu } from './provider';
import { createExtensionTransport, type ZafuHandle } from './transport';
import { ZafuError, classifyWalletError } from './errors';

// -- base64 (browser btoa/atob; avoids a Buffer dependency) --
const b64encode = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const b64decode = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

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
  if (typeof resp === 'object' && resp !== null && 'success' in resp && resp.success === false) {
    const r = resp as { error?: string; code?: string };
    throw classifyWalletError(r.error, r.code);
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
  const d = await detect(handle);
  if (!d.installed || !handle) {
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

/** fetch a recipient's advertised keys (the site-scoped ZID pubkeys). */
export async function zidPubkey(zafu: ZafuHandle): Promise<ZidRecipient> {
  const resp = (await call(zafu, 'zafu_zid_pubkey', {
    type: 'zafu_zid_pubkey',
  })) as Exclude<ZafuZidPubkeyResponse, { error: string }>;
  return { pubkey: resp.pubkey, pq_pubkey: resp.pq_pubkey, pq_suite: resp.pq_suite };
}

/**
 * Encrypt `plaintext` to a recipient. Uses the post-quantum sealed box whenever
 * the recipient advertises `pq_pubkey` (harvest-now-decrypt-later resistant),
 * falling back to the classical sealed box otherwise. Returns the sealed
 * ciphertext plus the ephemeral pubkey the recipient needs to open it (empty for
 * the post-quantum path, where the ephemeral is inside the ciphertext).
 */
export async function encryptFor(
  zafu: ZafuHandle,
  recipient: ZidRecipient,
  plaintext: Uint8Array,
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
  const resp = (await call(zafu, 'zafu_encrypt', req)) as Exclude<
    ZafuEncryptResponse,
    { error: string }
  >;
  return {
    ciphertext: resp.ciphertext,
    ephemeral_pubkey: resp.ephemeral_pubkey,
    postQuantum: Boolean(recipient.pq_pubkey),
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
  })) as Exclude<ZafuDecryptResponse, { error: string }>;
  return b64decode(resp.plaintext);
}
