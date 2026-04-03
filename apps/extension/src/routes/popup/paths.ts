export enum PopupPath {
  // Main tabs (Keplr-style)
  INDEX = '/',
  STAKE = '/stake',
  SWAP = '/swap',
  VOTE = '/vote',
  INBOX = '/inbox',
  CONTACTS = '/contacts',
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

  // Cosmos airgap signing (dedicated window)
  COSMOS_SIGN = '/cosmos-sign',

  // Multisig
  MULTISIG = '/multisig',
  MULTISIG_CREATE = '/multisig/create',
  MULTISIG_JOIN = '/multisig/join',
  MULTISIG_SIGN = '/multisig/sign',
  NOTE_SYNC = '/note-sync',

  // zid contact picker (opened by external apps)
  CONTACT_PICKER = '/pick-contacts',

  // FROST approval (opened by external apps via zafu_frost_*)
  FROST_APPROVE = '/frost-approve',

  // Passwords (deterministic password generator)
  PASSWORDS = '/identity/passwords',

  // Capability approval (opened by external apps via zafu_request_capability)
  CAPABILITY_APPROVAL = '/approval/capability',

  // Settings sub-pages (multisig)
  SETTINGS_MULTISIG = '/settings/multisig',

  // Subscribe
  SUBSCRIBE = '/settings/subscribe',

  // Settings sub-pages
  SETTINGS_DEFAULT_FRONTEND = '/settings/default-frontend',
  SETTINGS_CONNECTED_SITES = '/settings/connected-sites',
  SETTINGS_CLEAR_CACHE = '/settings/clear-cache',
  SETTINGS_RECOVERY_PASSPHRASE = '/settings/recovery-passphrase',
  SETTINGS_ZIGNER = '/settings/zigner',
  SETTINGS_NETWORKS = '/settings/networks',
  SETTINGS_PRIVACY = '/settings/privacy',
  SETTINGS_WALLETS = '/settings/wallets',
  SETTINGS_ABOUT = '/settings/about',
}
