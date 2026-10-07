import { storedList } from './stored-list';

export type Capability =
  | 'connect' // see addresses, balances
  | 'sign_identity' // ZID ed25519 signing
  | 'send_tx' // request transaction signatures
  | 'export_fvk' // full viewing key export (grants read access to ALL transactions)
  | 'view_contacts' // read contact list
  | 'view_history' // read transaction history
  | 'frost' // create/join/sign multisig sessions
  | 'passkey' // register and sign in with a site-bound WebAuthn passkey
  | 'auto_sign' // skip per-tx confirmation (time-limited)
  | 'encrypt'; // sealed box encrypt/decrypt with ZID keys

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const CAPABILITY_META: Record<
  Capability,
  {
    label: string;
    description: string;
    risk: RiskLevel;
  }
> = {
  connect: {
    label: 'Connect',
    description: 'View your addresses and balances',
    risk: 'low',
  },
  sign_identity: {
    label: 'Identity signing',
    description: 'Sign challenges with your ZID identity key',
    risk: 'low',
  },
  send_tx: {
    label: 'Transaction requests',
    description: 'Request transaction signatures (each tx still requires approval)',
    risk: 'medium',
  },
  export_fvk: {
    label: 'Export viewing key',
    description: 'Full read access to all your transactions and balances',
    risk: 'high',
  },
  view_contacts: {
    label: 'View contacts',
    description: 'Read your contact list (names and addresses)',
    risk: 'medium',
  },
  view_history: {
    label: 'Transaction history',
    description: 'Read your past transaction history',
    risk: 'medium',
  },
  frost: {
    label: 'Multisig operations',
    description: 'Create, join, and sign threshold multisig wallets',
    risk: 'high',
  },
  passkey: {
    label: 'Passkey',
    description: 'Register a site-bound passkey and sign in with it',
    risk: 'medium',
  },
  auto_sign: {
    label: 'Auto-sign transactions',
    description: 'Sign transactions without individual approval popups',
    risk: 'critical',
  },
  encrypt: {
    // not "encryption on/off": zafu's own messages are always encrypted. This
    // lets a site seal and open its messages with a key zafu keeps for it.
    label: 'Site encryption keys',
    description: 'Let a site seal and open its messages with a key zafu keeps for that site',
    risk: 'medium',
  },
};

export interface OriginPermissions {
  origin: string;
  granted: Capability[];
  denied: Capability[];
  grantedAt: number;
  /**
   * per-capability grant expiry, for capabilities that must be re-approved
   * periodically rather than stand forever once granted (see
   * TIME_LIMITED_CAPABILITIES). Keyed by capability because different
   * capabilities on the same origin can be granted at different times -
   * a single origin-wide expiry could not represent that.
   */
  expires?: Partial<Record<Capability, number>>;
  displayName?: string; // user-chosen nickname at this site ("poker-alice")
  identity?: string; // which named identity to use ("default", "poker")
}

/**
 * Capabilities whose grant lets a site act SILENTLY, with no per-call
 * confirmation, once approved once: `zafu_decrypt`/`zafu_encrypt` (encrypt).
 * An interactive capability like `send_tx` or `passkey` (every sign-in takes
 * a tap) still shows a popup on every call, so a standing grant there is not
 * a standing silent-access grant - only these need a TTL.
 *
 * `auto_sign` is NOT included even though its own comment says "time-limited":
 * nothing in the codebase ever calls `hasCapability(perms, 'auto_sign')` - the
 * real auto-sign enforcement is the separate `trading-mode.ts` slice, with its
 * own independent origin-allowlist and expiry, unrelated to this capability
 * system. Stamping an expiry here would be inert plumbing for a capability
 * nothing reads (and `trading-mode.ts` is slated for removal on another
 * branch), so it is left out rather than wired to a dead reader.
 */
export const TIME_LIMITED_CAPABILITIES: ReadonlySet<Capability> = new Set(['encrypt']);

/** default lifetime of a time-limited grant before the site must be asked again. */
export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Single choke point for "is this capability usable right now". Every
 * capability check in the extension (message handlers and settings UI)
 * should go through this, not `perms.granted.includes(cap)` directly, so
 * expiry is enforced in exactly one place.
 *
 * A time-limited capability with no recorded expiry (grants made before this
 * TTL mechanism existed) is treated as expired - a safe default that asks the
 * site once more rather than silently trusting an un-timestamped grant. A
 * malformed or absurd expiry (non-finite, or further out than a fresh grant
 * could ever be stamped) is ALSO treated as expired, rather than trusted -
 * guards against a corrupted record or a stamp made under a skewed clock
 * granting far more than GRANT_TTL_MS of silent access.
 */
export function hasCapability(
  perms: OriginPermissions | undefined,
  cap: Capability,
  now: number = Date.now(),
): boolean {
  if (!perms) {
    return false;
  }
  if (!perms.granted.includes(cap)) {
    return false;
  }
  if (TIME_LIMITED_CAPABILITIES.has(cap)) {
    const expiresAt = perms.expires?.[cap];
    if (
      typeof expiresAt !== 'number' ||
      !Number.isFinite(expiresAt) ||
      now >= expiresAt ||
      expiresAt - now > GRANT_TTL_MS
    ) {
      return false;
    }
  }
  return true;
}

export function isDenied(perms: OriginPermissions | undefined, cap: Capability): boolean {
  if (!perms) {
    return false;
  }
  return storedList(perms.denied).includes(cap);
}
