export enum PopupPath {
  // Main tabs (Keplr-style)
  INDEX = '/',
  STAKE = '/stake',
  SWAP = '/swap',
  HISTORY = '/history',
  INBOX = '/inbox',
  CONTACTS = '/contacts',
  SETTINGS = '/settings',

  // Auth
  LOGIN = '/login',

  // Approvals
  TRANSACTION_APPROVAL = '/approval/tx',
  ORIGIN_APPROVAL = '/approval/origin',

  // Send/Receive
  SEND = '/send',
  RECEIVE = '/receive',

  // Cosmos airgap signing (dedicated window)
  COSMOS_SIGN = '/cosmos-sign',

  // Settings sub-pages
  SETTINGS_RPC = '/settings/rpc',
  SETTINGS_DEFAULT_FRONTEND = '/settings/default-frontend',
  SETTINGS_CONNECTED_SITES = '/settings/connected-sites',
  SETTINGS_AUTO_LOCK = '/settings/auto-lock',
  SETTINGS_CLEAR_CACHE = '/settings/clear-cache',
  SETTINGS_RECOVERY_PASSPHRASE = '/settings/recovery-passphrase',
  SETTINGS_NUMERAIRES = '/settings/numeraires',
  SETTINGS_ZIGNER = '/settings/zigner',
  SETTINGS_NETWORKS = '/settings/networks',
  SETTINGS_NETWORK_ENDPOINTS = '/settings/network-endpoints',
  SETTINGS_PARACHAINS = '/settings/parachains',
  SETTINGS_ABOUT = '/settings/about',
}
