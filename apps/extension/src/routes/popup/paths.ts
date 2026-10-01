export enum PopupPath {
  // Main tabs (Keplr-style)
  INDEX = '/',
  STAKE = '/stake',
  SWAP = '/swap',
  VOTE = '/vote',
  INBOX = '/inbox',
  /** multisig group coordination chat, one thread per group (wallet id param) */
  INBOX_GROUP = '/inbox/group/:walletId',
  CONTACTS = '/contacts',
  TOOLS = '/tools',
  SETTINGS = '/settings',

  // Identity
  IDENTITY = '/identity',

  // Auth
  LOGIN = '/login',

  // Approvals
  TRANSACTION_APPROVAL = '/approval/tx',
  ORIGIN_APPROVAL = '/approval/origin',
  SIGN_APPROVAL = '/approval/sign',

  // Send/Receive
  SEND = '/send',
  RECEIVE = '/receive',
  INJECTIVE = '/injective',

  // Cosmos airgap signing (dedicated window)
  COSMOS_SIGN = '/cosmos-sign',

  // Multisig
  MULTISIG = '/multisig',
  MULTISIG_CREATE = '/multisig/create',
  MULTISIG_JOIN = '/multisig/join',
  // QR-mediated DKG variants used when the active wallet is a zigner-imported
  // (airgapSigner) account. zafu mediates between the FROST relay and zigner;
  // the FROST share is born and stored on zigner only.
  MULTISIG_SIGN = '/multisig/sign',
  NOTE_SYNC = '/note-sync',

  // every transaction (home shows the newest few)
  ACTIVITY = '/activity',

  // Per-pool Zcash notes (orchard legacy vs ironwood); IRONWOOD_MIGRATION-gated
  POOL_NOTES = '/pool-notes',

  // zid contact picker (opened by external apps)
  CONTACT_PICKER = '/pick-contacts',

  // FROST approval (opened by external apps via zafu_frost_*)
  FROST_APPROVE = '/frost-approve',

  // Passkey creation consent (opened by external apps via zafu_passkey_create)
  PASSKEY_APPROVE = '/passkey-approve',

  // Passwords (deterministic password generator)
  PASSWORDS = '/identity/passwords',

  // Capability approval (opened by external apps via zafu_request_capability)
  CAPABILITY_APPROVAL = '/approval/capability',

  // Contact-discovery consent (opened by external apps via zafu_request_contact_discovery)
  CONTACT_DISCOVERY_APPROVAL = '/approval/contact-discovery',

  // Outbound-destination consent (raised by the egress gate when a dapp
  // introduces a host that is not in zafu's config for an enabled network)
  DESTINATION_APPROVAL = '/approval/destination',

  // Zcash multi-output send approval (opened by external apps via zafu_zcash_send)
  ZCASH_SEND_APPROVAL = '/approval/zcash-send',
  // Keplr provider approval (connect + cosmos signing, opened by cosmos dapps)
  KEPLR_APPROVAL = '/approval/keplr',

  // Settings sub-pages (multisig)
  SETTINGS_MULTISIG = '/settings/multisig',
  SETTINGS_MULTISIG_BACKUP = '/settings/multisig-backup',

  // Subscribe
  SUBSCRIBE = '/settings/subscribe',

  // Settings sub-pages
  SETTINGS_DEFAULT_FRONTEND = '/settings/default-frontend',
  SETTINGS_CONNECTED_SITES = '/settings/connected-sites',
  SETTINGS_CLEAR_CACHE = '/settings/clear-cache',
  SETTINGS_RECOVERY_PASSPHRASE = '/settings/recovery-passphrase',
  SETTINGS_SECURITY_BACKUP = '/settings/security-backup',
  SETTINGS_ZIGNER = '/settings/zigner',
  SETTINGS_NETWORKS = '/settings/networks',
  SETTINGS_PRIVACY = '/settings/privacy',
  SETTINGS_FEATURES = '/settings/features',
  SETTINGS_WALLETS = '/settings/wallets',
  SETTINGS_ABOUT = '/settings/about',
  SETTINGS_OTA = '/settings/ota',
  SETTINGS_VOTING = '/settings/voting',
  SETTINGS_ZCASHME = '/settings/zcashme',
  SETTINGS_ADD_VIEWING_KEY = '/settings/add-viewing-key',

  // Settings IA rework: four category homes + a couple of new screens the
  // category rows need (see routes/popup/settings/AGENTS scope). Every path
  // above this line still resolves to its existing screen.
  SETTINGS_SECURITY = '/settings/security',
  SETTINGS_PRIVACY_HOME = '/settings/privacy/home',
  SETTINGS_NETWORKS_HOME = '/settings/networks/home',
  SETTINGS_NETWORKS_ALL = '/settings/networks/all',
  SETTINGS_ZCASH_NETWORK = '/settings/networks/zcash',
  SETTINGS_DEVICES = '/settings/devices',
  SETTINGS_DEVICES_ALL = '/settings/devices/all',
  SETTINGS_REMOVE_WALLET = '/settings/remove-wallet',
  /** "everything zafu talks to" - every known destination, grouped by
   *  purpose, with an allow/block control per host. */
  SETTINGS_CONNECTIONS = '/settings/privacy/connections',
}
