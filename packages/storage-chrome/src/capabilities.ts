export type Capability =
  | 'connect'        // see addresses, balances
  | 'sign_identity'  // ZID ed25519 signing
  | 'send_tx'        // request transaction signatures
  | 'export_fvk'     // full viewing key export (grants read access to ALL transactions)
  | 'view_contacts'  // read contact list
  | 'view_history'   // read transaction history
  | 'frost'          // create/join/sign multisig sessions
  | 'auto_sign';     // skip per-tx confirmation (time-limited)

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const CAPABILITY_META: Record<Capability, {
  label: string;
  description: string;
  risk: RiskLevel;
}> = {
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
  auto_sign: {
    label: 'Auto-sign transactions',
    description: 'Sign transactions without individual approval popups',
    risk: 'critical',
  },
};

export interface OriginPermissions {
  origin: string;
  granted: Capability[];
  denied: Capability[];
  grantedAt: number;
  expiresAt?: number;      // for auto_sign TTL
  displayName?: string;    // user-chosen nickname at this site ("poker-alice")
  identity?: string;       // which named identity to use ("default", "poker")
}

export function hasCapability(perms: OriginPermissions | undefined, cap: Capability): boolean {
  if (!perms) return false;
  return perms.granted.includes(cap);
}

export function isDenied(perms: OriginPermissions | undefined, cap: Capability): boolean {
  if (!perms) return false;
  return perms.denied.includes(cap);
}
