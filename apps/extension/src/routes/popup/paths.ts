export enum PopupPath {
  // Main tabs (Keplr-style)
  INDEX = '/',
  STAKE = '/stake',
  SWAP = '/swap',
  VOTE = '/vote',
  INBOX = '/inbox',
  CONTACTS = '/contacts',
  SETTINGS = '/settings',

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
  MULTISIG_CREATE = '/multisig/create',
  MULTISIG_JOIN = '/multisig/join',
  MULTISIG_SIGN = '/multisig/sign',
  NOTE_SYNC = '/note-sync',

  // Settings sub-pages (multisig)
  SETTINGS_MULTISIG = '/settings/multisig',

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
