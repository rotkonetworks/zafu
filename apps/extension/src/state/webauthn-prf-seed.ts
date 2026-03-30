/**
 * webauthn-prf-seed - hardware-bound entropy from WebAuthn PRF extension
 *
 * DESIGN RATIONALE (research output, 2026-03-30)
 * ===============================================
 *
 * Goal: use the WebAuthn PRF extension (hmac-secret) to derive a hardware-bound
 * secret that strengthens or replaces the mnemonic as root entropy for ZID and
 * wallet key derivation.
 *
 * WHAT IS THE PRF EXTENSION?
 * --------------------------
 * The WebAuthn PRF extension (Level 3 spec, shipped in Chrome 116+, Firefox 122+,
 * Safari 18+) allows relying parties to evaluate a pseudo-random function seeded
 * by a per-credential secret held inside the authenticator hardware.
 *
 * Flow:
 *   1. RP sends salt(s) during navigator.credentials.get({ extensions: { prf: { eval: { first: salt } } } })
 *   2. Authenticator internally computes HMAC-SHA-256(credential_secret, salt)
 *   3. Result is returned in getClientExtensionResults().prf.results.first
 *
 * The credential_secret NEVER leaves the authenticator. The output is deterministic:
 * same credential + same salt = same output, every time. This makes it usable as
 * stable key material.
 *
 * Under the hood, this is the CTAP2 hmac-secret extension. Platform authenticators
 * (Windows Hello, macOS Touch ID, Android) and security keys (YubiKey 5+) support it.
 *
 * SECURITY PROPERTIES
 * -------------------
 * 1. Hardware-bound: the credential secret is generated inside the authenticator's
 *    secure element. It cannot be exported, cloned, or read by software. Even if
 *    the browser is fully compromised, the attacker cannot extract the PRF seed -
 *    they can only request evaluations (which requires user gesture).
 *
 * 2. User presence required: every PRF evaluation requires a user gesture (biometric,
 *    PIN, or touch). This means malware cannot silently harvest PRF outputs.
 *
 * 3. Deterministic: same salt -> same output. This is critical - we can use the output
 *    as stable key derivation material without needing to store anything.
 *
 * 4. Per-credential isolation: each passkey has its own independent secret. Two passkeys
 *    on the same authenticator produce unrelated PRF outputs.
 *
 * 5. Origin-bound: passkeys are bound to the relying party ID. A malicious site cannot
 *    request PRF evaluation for a credential registered to a different RP.
 *
 * WHAT THIS ENABLES FOR ZAFU
 * --------------------------
 *
 * MODE 1: PRF as additional factor (RECOMMENDED)
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * Combined derivation: seed = HKDF(ikm = PRF_output || password_key, salt = "zafu-prf-v1", info = "vault-seed")
 *
 * Security model:
 *   - Compromise password alone: useless without authenticator
 *   - Compromise authenticator alone: useless without password
 *   - Mnemonic backup: still works independently (mnemonic is entropy source, PRF is vault protection)
 *   - PRF is not an entropy source for the mnemonic itself - it protects the vault encryption key
 *
 * This is the right design because:
 *   a. The mnemonic is the canonical backup. Users write it down. It must work without PRF.
 *   b. PRF strengthens the "online" protection - the vault at rest on disk.
 *   c. Even with a weak password, an attacker who steals the encrypted vault
 *      cannot decrypt it without the authenticator present + user gesture.
 *   d. This is strictly additive security - removing PRF falls back to password-only.
 *
 * MODE 2: PRF as sole entropy for mnemonic generation (REJECTED)
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * We could use PRF output as entropy for bip39 mnemonic generation:
 *   mnemonic = entropyToMnemonic(PRF_output)
 *
 * This is a BAD idea because:
 *   a. PRF output is hardware-bound and non-exportable. If the authenticator is
 *      lost/broken, the entropy is gone forever. No backup possible.
 *   b. The whole point of mnemonics is offline backup. Tying mnemonic entropy to
 *      a single hardware device defeats the purpose entirely.
 *   c. Even with multiple authenticators, there is no standard way to sync
 *      credential secrets between them. Each gets its own independent secret.
 *   d. Discoverable credentials can sync via passkey providers (iCloud, Google),
 *      but the hmac-secret is NOT guaranteed to sync - this is implementation-
 *      dependent and currently unreliable.
 *
 * MODE 3: PRF as hardware 2FA for vault decryption (THIS FILE)
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * This is a refinement of Mode 1. The vault encryption key becomes:
 *   vault_key = HKDF-SHA256(ikm = PBKDF2(password, salt) || PRF(credential, prf_salt), info = "zafu-vault-v1")
 *
 * Recovery flow when PRF is enrolled:
 *   - Normal unlock: password + authenticator tap -> vault decrypted
 *   - Recovery: import mnemonic -> re-create vault -> optionally re-enroll PRF
 *   - PRF loss: cannot unlock existing vault, but mnemonic backup restores everything
 *
 * RELYING PARTY ID AND PRIVACY
 * ----------------------------
 * The RP ID for passkey registration determines which origins can use the credential.
 * For a Chrome extension, the RP ID situation is:
 *
 *   - Extensions use chrome-extension://<extension-id> as origin
 *   - We register passkeys with rpId = <extension-id> (the extension's stable ID)
 *   - This is privacy-preserving: the RP ID is the extension ID, not a server domain
 *   - No network request is needed for PRF evaluation - it is purely local
 *   - The authenticator never phones home
 *
 * The extension ID is stable across installs for CRX-published extensions.
 * For development builds, it changes - but that is acceptable (dev != prod keys).
 *
 * BROWSER SUPPORT AND PLATFORM CONSIDERATIONS
 * --------------------------------------------
 *
 * Platform authenticators:
 *   - Windows Hello: PRF supported (Win 10 1903+). Uses TPM.
 *   - macOS Touch ID: PRF supported (macOS 14+, Safari 18+, Chrome 120+).
 *   - Android: PRF supported on Pixel 6+ / Samsung S21+. Backed by StrongBox/TEE.
 *   - Linux: NO platform authenticator. Must use security key.
 *
 * Security keys:
 *   - YubiKey 5 series: PRF supported via hmac-secret CTAP2 extension.
 *   - SoloKeys v2: supported.
 *   - Older keys (U2F-only): NOT supported. PRF requires CTAP2.
 *
 * Synced passkeys (iCloud Keychain, Google Password Manager):
 *   - PRF output may differ across devices because the credential secret
 *     is NOT guaranteed to be the same after sync. Apple's implementation
 *     does sync the hmac-secret as of iOS 18, but Google's behavior is
 *     less documented. We should treat synced passkeys as UNRELIABLE for PRF
 *     and warn users to prefer hardware-bound (non-synced) credentials.
 *
 * Graceful degradation:
 *   - If PRF is not available, fall back to password-only vault encryption.
 *   - Feature detection: check getClientExtensionResults().prf.enabled during create,
 *     or attempt a PRF eval during get and handle the missing results.
 *   - UI should clearly indicate whether PRF is active ("hardware-protected" badge).
 *
 * IMPLEMENTATION NOTES
 * --------------------
 *
 * The existing passkey-intercept.ts intercepts navigator.credentials and routes
 * through the extension. For PRF-as-vault-protection, we need the OPPOSITE flow:
 * we call the REAL navigator.credentials.get (not our intercept) to get a PRF
 * output from the actual hardware authenticator.
 *
 * This means PRF enrollment and evaluation must happen in a context that has
 * access to the real WebAuthn API - either:
 *   a. The extension popup (has access to chrome.webauthn if available)
 *   b. An offscreen document (Chrome 109+) that can call navigator.credentials
 *   c. A tab opened to a zafu-controlled page
 *
 * Chrome extensions cannot directly call navigator.credentials from the service
 * worker. The popup CAN call it (it is a normal browsing context). This is the
 * simplest path.
 *
 * SALT DESIGN
 * -----------
 * We use a fixed, well-known salt for PRF evaluation. The salt does not need to
 * be secret - the credential secret inside the authenticator provides all entropy.
 * Using a fixed salt means we do not need to store anything per-credential.
 *
 * PRF_SALT = SHA-256("zafu-prf-vault-v1")
 *
 * If we ever need to rotate (e.g., a new vault encryption scheme), we change the
 * salt domain string. Old vaults remain decryptable with the old salt until migrated.
 */

import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';

const enc = new TextEncoder();

/**
 * Fixed PRF evaluation salt.
 * The authenticator computes HMAC(credential_secret, this_salt) to produce
 * the hardware-bound secret. Changing this salt produces a completely different
 * output - effectively rotating the hardware factor.
 */
export const PRF_SALT = sha256(enc.encode('zafu-prf-vault-v1'));

/**
 * A second salt for key verification - used to detect correct PRF without
 * exposing the primary secret. The authenticator evaluates both salts in
 * one gesture (PRF extension supports first + second).
 */
export const PRF_VERIFY_SALT = sha256(enc.encode('zafu-prf-verify-v1'));

/**
 * Relying party ID for the extension's own credentials.
 * In production this is the stable extension ID from the Chrome Web Store.
 * In development, use the unpacked extension ID.
 */
export const getExtensionRpId = (): string => {
  // chrome.runtime.id is the extension's stable identifier
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    return chrome.runtime.id;
  }
  // fallback for testing
  return 'zafu-dev';
};

// -- enrollment data (stored alongside vault metadata) --

export interface PrfEnrollment {
  /** credential ID (base64url) from the passkey used for PRF */
  credentialId: string;
  /** HMAC(PRF_output_verify, "enrolled") - proves correct PRF without exposing secrets */
  verifier: string;
  /** timestamp of enrollment */
  enrolledAt: number;
  /** human-readable label ("YubiKey", "Touch ID", etc.) */
  label: string;
}

// -- key derivation --

/**
 * Combine password-derived key material with PRF output to produce the vault
 * encryption key.
 *
 * Uses HKDF-SHA256:
 *   ikm  = passwordKey || prfOutput   (concatenation, not XOR - both are high entropy)
 *   salt = "zafu-vault-prf-v1"
 *   info = "vault-encryption"
 *   len  = 32 bytes
 *
 * Why concatenation over XOR:
 *   - Both inputs are independently high-entropy (PBKDF2 output + HMAC output)
 *   - Concatenation into HKDF is the standard approach (see RFC 5869 section 3.1)
 *   - XOR would be fine too since both are 32 bytes, but concat + HKDF is more
 *     explicit about the dual-source nature
 *
 * Security: if either factor is compromised in isolation, the combined key is
 * still computationally infeasible to derive without the other factor (assuming
 * the HKDF extract step produces a uniformly random PRK).
 */
export function deriveVaultKeyWithPrf(
  passwordKeyBytes: Uint8Array,
  prfOutput: Uint8Array,
): Uint8Array {
  const ikm = concatBytes(passwordKeyBytes, prfOutput);
  const salt = enc.encode('zafu-vault-prf-v1');
  const info = enc.encode('vault-encryption');
  const key = hkdf(sha256, ikm, salt, info, 32);
  // zeroize intermediate
  ikm.fill(0);
  return key;
}

/**
 * Derive a verifier from the PRF verify output. This is stored unencrypted
 * alongside the vault to detect whether the correct authenticator was used,
 * BEFORE attempting vault decryption (avoids confusing "wrong password" errors
 * when the real problem is wrong/missing authenticator).
 *
 * verifier = SHA-256("zafu-prf-enrolled" || prfVerifyOutput)
 *
 * This is a one-way function - the PRF output cannot be recovered from it.
 */
export function computePrfVerifier(prfVerifyOutput: Uint8Array): string {
  const tag = enc.encode('zafu-prf-enrolled');
  const input = concatBytes(tag, prfVerifyOutput);
  const hash = sha256(input);
  input.fill(0);
  return bytesToHex(hash);
}

/**
 * Check if the PRF verify output matches a stored verifier.
 * Use this before attempting vault decryption to give the user a clear error
 * ("wrong authenticator") rather than a generic decryption failure.
 */
export function checkPrfVerifier(prfVerifyOutput: Uint8Array, storedVerifier: string): boolean {
  return computePrfVerifier(prfVerifyOutput) === storedVerifier;
}

// -- WebAuthn PRF interaction --

/**
 * Request PRF evaluation from a real hardware authenticator.
 *
 * This calls the REAL navigator.credentials.get (not our intercept) with the
 * PRF extension. Must be called from a context with WebAuthn access (popup,
 * offscreen document, or tab).
 *
 * Returns both the primary PRF output (for key derivation) and the verify
 * output (for enrollment verification).
 *
 * Throws if:
 *   - User cancels the gesture
 *   - Authenticator does not support PRF
 *   - No matching credential found
 */
export async function evaluatePrf(
  credentialId: string,
): Promise<{ primary: Uint8Array; verify: Uint8Array } | null> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    return null;
  }

  const rpId = getExtensionRpId();

  // decode base64url credential ID
  const rawId = base64urlToBytes(credentialId);

  const assertion = await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: rawId.buffer as ArrayBuffer, type: 'public-key' }],
      userVerification: 'required',
      extensions: {
        prf: {
          eval: {
            first: PRF_SALT.buffer as ArrayBuffer,
            second: PRF_VERIFY_SALT.buffer as ArrayBuffer,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;

  if (!assertion) return null;

  const results = (assertion.getClientExtensionResults() as Record<string, unknown>)
    ?.['prf'] as { results?: { first?: ArrayBuffer; second?: ArrayBuffer } } | undefined;

  if (!results?.results?.first) {
    // authenticator does not support PRF
    return null;
  }

  const primary = new Uint8Array(results.results.first);
  const verify = results.results.second
    ? new Uint8Array(results.results.second)
    : new Uint8Array(0);

  return { primary, verify };
}

/**
 * Create a new passkey credential with PRF support detection.
 *
 * Used during PRF enrollment. We create a dedicated credential for vault
 * protection - separate from any passkeys we might manage for external sites.
 *
 * Returns the credential ID and whether PRF is supported.
 */
export async function createPrfCredential(
  label: string,
): Promise<{ credentialId: string; prfSupported: boolean } | null> {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    return null;
  }

  const rpId = getExtensionRpId();
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: 'Zafu Wallet' },
      user: {
        id: userId,
        name: 'zafu-vault-prf',
        displayName: label || 'Zafu Vault Key',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256 (P-256)
        { alg: -257, type: 'public-key' },  // RS256 (RSA) fallback
      ],
      authenticatorSelection: {
        // prefer hardware-bound credentials for PRF reliability
        authenticatorAttachment: 'cross-platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      extensions: {
        prf: {},
      } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;

  if (!credential) return null;

  const credentialId = bytesToBase64url(new Uint8Array(credential.rawId));
  const extensionResults = credential.getClientExtensionResults() as Record<string, unknown>;
  const prfSupported = !!(extensionResults?.['prf'] as { enabled?: boolean })?.enabled;

  return { credentialId, prfSupported };
}

/**
 * Full enrollment flow:
 * 1. Create a credential with PRF support
 * 2. Evaluate PRF to get the initial outputs
 * 3. Compute and return the enrollment data + key material
 *
 * The caller must then re-encrypt the vault with deriveVaultKeyWithPrf().
 */
export async function enrollPrf(
  label: string,
): Promise<{
  enrollment: PrfEnrollment;
  prfPrimary: Uint8Array;
} | null> {
  // step 1: create credential
  const created = await createPrfCredential(label);
  if (!created || !created.prfSupported) {
    return null;
  }

  // step 2: evaluate PRF with the new credential
  const prfResult = await evaluatePrf(created.credentialId);
  if (!prfResult) {
    return null;
  }

  // step 3: build enrollment
  const verifier = computePrfVerifier(prfResult.verify);

  const enrollment: PrfEnrollment = {
    credentialId: created.credentialId,
    verifier,
    enrolledAt: Date.now(),
    label,
  };

  // zeroize verify output (primary is returned to caller)
  prfResult.verify.fill(0);

  return { enrollment, prfPrimary: prfResult.primary };
}

// -- base64url helpers --

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
