export { type LOCAL, type SYNC, type VERSION };

type VERSION = 2;

type SYNC = void;

type BoxJson = { cipherText: string; nonce: string };

type LOCAL = {
  // required values
  knownSites: { choice: 'Approved' | 'Denied' | 'Ignored'; date: number; origin: string }[];
  /** Stringified AssetId */
  numeraires: string[];
  wallets: {
    custody:
      | { encryptedSeedPhrase: BoxJson }
      | { airgapSigner: BoxJson };
    /** Stringified FullViewingKey */
    fullViewingKey: string;
    /** Stringified WalletId */
    id: string;
    label: string;
  }[];

  // optional values
  /** Index of the active wallet (default 0) */
  activeWalletIndex?: number;
  backupReminderSeen?: boolean;
  /** integer */
  compactFrontierBlockHeight?: number;
  /** url string */
  frontendUrl?: string;
  /** integer */
  fullSyncHeight?: number;
  /** url string */
  grpcEndpoint?: string;
  /** Stringified AppParameters */
  params?: string;
  /** KeyPrintJson */
  passwordKeyPrint?: { hash: string; salt: string };
  /** integer */
  walletCreationBlockHeight?: number;
  /** Whether camera is enabled for Zigner QR scanning */
  zignerCameraEnabled?: boolean;
  /** Flag indicating cache clearing is in progress (survives extension restart) */
  clearingCache?: boolean;
  /** Active network type for multi-network wallet */
  activeNetwork?: 'penumbra' | 'zcash' | 'polkadot' | 'cosmos';
  /** Zcash-specific wallets */
  zcashWallets?: {
    id: string;
    label: string;
    orchardFvk: string;
    address: string;
    accountIndex: number;
    mainnet: boolean;
  }[];
  /** Multi-network zigner wallets */
  zignerWallets?: {
    id: string;
    label: string;
    zignerAccountIndex: number;
    importedAt: number;
    networks: {
      penumbra?: { fullViewingKey: string; address: string };
      zcash?: { orchardFvk: string; unifiedAddress: string; mainnet: boolean };
      polkadot?: { publicKey: string; ss58Address: string; scheme: 'sr25519' | 'ed25519'; chain: string };
      cosmos?: { publicKey: string; address: string; enabledChains: string[] };
    };
  }[];
  /** Trading mode settings */
  tradingMode?: {
    autoSign: boolean;
    allowedOrigins: string[];
    sessionDurationMinutes: number;
    expiresAt: number;
    maxValuePerSwap: string;
  };
  /** Privacy settings - controls opt-in network queries */
  privacySettings?: {
    enableTransparentBalances: boolean;
    enableTransactionHistory: boolean;
    enableBackgroundSync: boolean;
    enablePriceFetching: boolean;
  };
  /** Enabled networks - only these get loaded at startup */
  enabledNetworks?: ('penumbra' | 'zcash' | 'osmosis' | 'noble' | 'nomic' | 'celestia' | 'polkadot' | 'kusama' | 'ethereum' | 'bitcoin')[];
  /** Per-network custom endpoints */
  networkEndpoints?: {
    penumbra?: string;
    zcash?: string;
    osmosis?: string;
    noble?: string;
    nomic?: string;
    celestia?: string;
    polkadot?: string;
    kusama?: string;
    ethereum?: string;
    bitcoin?: string;
  };

  /** keyring vaults (keplr-style multi-account) */
  vaults?: {
    id: string;
    type: 'mnemonic' | 'zigner-zafu' | 'ledger';
    name: string;
    createdAt: number;
    encryptedData: string;
    salt: string;
    insensitive: Record<string, unknown>;
  }[];
  /** currently selected vault id */
  selectedVaultId?: string;
};
