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
    /** Links this wallet to a keyring vault */
    vaultId?: string;
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
  activeNetwork?: 'penumbra' | 'zcash' | 'polkadot' | 'kusama' | 'osmosis' | 'noble' | 'nomic' | 'celestia' | 'ethereum' | 'bitcoin';
  /** Zcash-specific wallets */
  zcashWallets?: {
    id: string;
    label: string;
    orchardFvk: string;
    address: string;
    accountIndex: number;
    mainnet: boolean;
  }[];
  /** Polkadot zigner watch-only accounts */
  polkadotZignerAccounts?: {
    id: string;
    label: string;
    ss58Address: string;
    genesisHash: string;
    importedAt: number;
  }[];
  /** Active polkadot zigner account index */
  activePolkadotZignerIndex?: number;
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

  /** address book contacts - each contact can have multiple addresses */
  contacts?: {
    id: string;
    name: string;
    /** general notes about the contact */
    notes?: string;
    /** is this a favorite */
    favorite?: boolean;
    /** when was this contact added */
    createdAt: number;
    /** addresses across different networks */
    addresses: {
      id: string;
      /** network type for this address */
      network: 'penumbra' | 'zcash' | 'cosmos' | 'polkadot' | 'kusama' | 'ethereum' | 'bitcoin';
      /** bech32 or other address format */
      address: string;
      /** for cosmos, which chain (osmosis, noble, etc) */
      chainId?: string;
      /** notes specific to this address */
      notes?: string;
      /** last time this address was used for sending */
      lastUsedAt?: number;
    }[];
  }[];

  /** recently used addresses for quick access */
  recentAddresses?: {
    address: string;
    network: 'penumbra' | 'zcash' | 'cosmos' | 'polkadot' | 'ethereum' | 'bitcoin';
    chainId?: string;
    useCount: number;
    lastUsedAt: number;
    firstUsedAt: number;
  }[];

  /** addresses user declined to save as contacts */
  dismissedContactSuggestions?: string[];

  /** enabled parachains per relay network */
  enabledParachains?: {
    polkadot?: string[];
    kusama?: string[];
  };

  /** custom chainspecs added by user */
  customChainspecs?: {
    id: string;
    name: string;
    relay: 'polkadot' | 'kusama' | 'paseo' | 'standalone';
    symbol?: string;
    decimals?: number;
    chainspec: string; // full JSON chainspec
    addedAt: number;
  }[];

  /** polkadot vault settings */
  polkadotVaultSettings?: {
    /** use legacy qr format for older parity signer / polkadot vault */
    legacyMode: boolean;
  };

  /** encrypted message inbox (from tx memos) */
  messages?: {
    id: string;
    /** network this message was sent on */
    network: 'penumbra' | 'zcash';
    /** sender address (if known, might be shielded) */
    senderAddress?: string;
    /** recipient address (our address) */
    recipientAddress: string;
    /** the message content (decrypted memo) */
    content: string;
    /** transaction id/hash */
    txId: string;
    /** block height */
    blockHeight: number;
    /** timestamp */
    timestamp: number;
    /** whether we sent or received this message */
    direction: 'sent' | 'received';
    /** whether this message has been read */
    read: boolean;
    /** optional amount if this was a payment with memo */
    amount?: string;
    /** asset/denom */
    asset?: string;
  }[];
};
