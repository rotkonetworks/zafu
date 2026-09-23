export { type LOCAL, type SYNC, type VERSION };

type VERSION = 3;

type SYNC = void;

type BoxJson = { cipherText: string; nonce: string };

/**
 * v3 extends v2 with two additive maps that support fresh burner-address
 * rotation for external dapps (per docs/design/burner-rotation.md and gh #34):
 *
 *   - `cosmosChainCounters`  — per-chain HD index counter used by
 *     `nextHdIndex(chainId)` on the unshield path so every exit derives a fresh
 *     inj1…/osmo1… address. Standard cosmos chains rotate the BIP44
 *     address_index in m/44'/118'/0'/0/n; Ethermint chains (Injective) rotate
 *     the coin-60 index in m/44'/60'/0'/0/n. Absent map == every chain at 0.
 *
 *   - `cosmosFreshAddressRateLimits` — per-origin+chain sliding 24 h window
 *     tracker. Caps a malicious site at 100 fresh derivations per day so it
 *     cannot balloon the counter into the millions and later hand the user a
 *     UX bomb (or run the wallet through an expensive derivation loop). Keyed
 *     `<origin>|<chainId>` because rate limits are per-origin per-chain.
 *
 * Both fields are optional, so a v2 wallet reads as `{}` after the passthrough
 * migration and behaves exactly as before — no counters allocated, no rate
 * limits, no rotation until an origin actually calls
 * `zafu_get_fresh_chain_address`.
 */
type CosmosChainCounters = Record<string, number>;
type CosmosFreshAddressRateLimit = { count: number; windowStart: number };
type CosmosFreshAddressRateLimits = Record<string, CosmosFreshAddressRateLimit>;

type LOCAL = {
  // required values
  knownSites: { choice: 'Approved' | 'Denied' | 'Ignored'; date: number; origin: string }[];
  /** Stringified AssetId */
  numeraires: string[];
  penumbraWallets: {
    custody: { encryptedSeedPhrase: BoxJson } | { airgapSigner: BoxJson };
    /** Stringified FullViewingKey */
    fullViewingKey: string;
    /** Stringified WalletId */
    id: string;
    label: string;
    /** Links this wallet to a keyring vault */
    vaultId?: string;
  }[];

  // optional values
  frostRelayIdentities?: Record<string, { privateKey: string; publicKey: string }>;
  groupChats?: Record<
    string,
    {
      chatSessionId?: string;
      messages: {
        id: string;
        senderPub: string;
        body: string;
        ts: number;
        recvTs: number;
        mine: boolean;
      }[];
    }
  >;
  activeWalletIndex?: number;
  backupReminderSeen?: boolean;
  seedPhraseBackedUp?: boolean;
  keplrCompat?: boolean;
  compactFrontierBlockHeight?: number;
  frontendUrl?: string;
  fullSyncHeight?: number;
  grpcEndpoint?: string;
  params?: string;
  passwordKeyPrint?: { hash: string; salt: string };
  walletCreationBlockHeight?: number;
  zignerCameraEnabled?: boolean;
  cosmosAddressIndex?: number;
  approvalsInSidePanel?: boolean;
  clearingCache?: boolean;
  pendingClearCache?: ('penumbra' | 'zcash')[];
  activeNetwork?:
    | 'penumbra'
    | 'zcash'
    | 'polkadot'
    | 'kusama'
    | 'noble'
    | 'cosmoshub'
    | 'osmosis'
    | 'injective'
    | 'ethereum'
    | 'bitcoin';
  zcashWallets?: {
    id: string;
    label: string;
    orchardFvk: string;
    address: string;
    transparentAddress?: string;
    accountIndex: number;
    mainnet: boolean;
    vaultId?: string;
    coldSignerType?: 'zigner' | 'keystone' | 'ledger';
  }[];
  activeZcashIndex?: number;
  polkadotZignerAccounts?: {
    id: string;
    label: string;
    ss58Address: string;
    genesisHash: string;
    importedAt: number;
  }[];
  activePolkadotZignerIndex?: number;
  zignerWallets?: {
    id: string;
    label: string;
    zignerAccountIndex: number;
    importedAt: number;
    networks: {
      penumbra?: { fullViewingKey: string; address: string };
      zcash?: { orchardFvk: string; unifiedAddress: string; mainnet: boolean };
      polkadot?: {
        publicKey: string;
        ss58Address: string;
        scheme: 'sr25519' | 'ed25519';
        chain: string;
      };
      cosmos?: { publicKey: string; address: string; enabledChains: string[] };
    };
  }[];
  tradingMode?: {
    autoSign: boolean;
    allowedOrigins: string[];
    sessionDurationMinutes: number;
    expiresAt: number;
    maxValuePerSwap: string;
  };
  privacySettings?: {
    enableTransparentBalances: boolean;
    enableTransactionHistory: boolean;
    enableBackgroundSync: boolean;
    enablePriceFetching: boolean;
  };
  enabledNetworks?: (
    | 'penumbra'
    | 'zcash'
    | 'noble'
    | 'cosmoshub'
    | 'osmosis'
    | 'injective'
    | 'polkadot'
    | 'kusama'
    | 'ethereum'
    | 'bitcoin'
  )[];
  networkEndpoints?: {
    penumbra?: string;
    zcash?: string;
    noble?: string;
    cosmoshub?: string;
    polkadot?: string;
    kusama?: string;
    ethereum?: string;
    bitcoin?: string;
  };
  memoSyncStrategies?: {
    zcash?: 'private' | 'fast' | 'paranoid';
  };
  mempoolWatchSettings?: {
    zcash?: 'off' | 'on';
  };
  /**
   * How the endpoint picker chooses among preset nodes when the user hits
   * "smart pick". `manual` means: never auto-pick, the last-saved endpoint
   * URL wins even after a fresh latency probe. Optional (default 'fastest');
   * new additive field, absent for pre-existing installs.
   */
  endpointSelectionStrategies?: {
    zcash?: 'fastest' | 'most-synced' | 'random' | 'manual';
  };
  zcashBackend?: 'zidecar' | 'lightwalletd';

  votingConfigOverride?: {
    enabled: boolean;
    url: string;
    sha256: string | null;
  };

  zcashMeConfig?: {
    mode: 'off' | 'directory' | 'live';
    mirrorUrl: string;
    apiKey: string;
    promptDismissed?: boolean;
    decoys?: number;
  };

  zcashMeDirectory?: {
    version: 1;
    fetchedAt: number;
    source: string;
    profiles: {
      username: string;
      displayName: string | null;
      address: string;
      addressVerified: boolean;
      bio: string | null;
      location: string | null;
      profileImageUrl: string | null;
      links: { platform: string; label: string; url: string }[];
    }[];
  };

  vaults?: {
    id: string;
    type: 'mnemonic' | 'zigner-zafu' | 'frost-multisig' | 'ledger' | 'trezor' | 'keystone';
    name: string;
    createdAt: number;
    encryptedData: string;
    salt: string;
    insensitive: Record<string, unknown>;
  }[];
  selectedVaultId?: string;

  contacts?: {
    id: string;
    name: string;
    notes?: string;
    favorite?: boolean;
    createdAt: number;
    addresses: {
      id: string;
      network: 'penumbra' | 'zcash' | 'cosmos' | 'polkadot' | 'kusama' | 'ethereum' | 'bitcoin';
      address: string;
      chainId?: string;
      notes?: string;
      lastUsedAt?: number;
    }[];
  }[];

  recentAddresses?: {
    address: string;
    network: 'penumbra' | 'zcash' | 'cosmos' | 'polkadot' | 'ethereum' | 'bitcoin';
    chainId?: string;
    useCount: number;
    lastUsedAt: number;
    firstUsedAt: number;
  }[];

  dismissedContactSuggestions?: string[];

  enabledParachains?: {
    polkadot?: string[];
    kusama?: string[];
  };

  customChainspecs?: {
    id: string;
    name: string;
    relay: 'polkadot' | 'kusama' | 'paseo' | 'standalone';
    symbol?: string;
    decimals?: number;
    chainspec: string;
    addedAt: number;
  }[];

  zidPreferences?: Record<
    string,
    {
      mode: 'cross-site' | 'site';
      rotation: number;
      identity: string;
    }
  >;

  zidShareLog?: {
    publicKey: string;
    sharedWith: string;
    sharedAt: number;
    identity: string;
  }[];

  zidDiscovery?: {
    enabled: boolean;
    relayEndpoint: string;
    relayToken?: string;
  };

  zidSiteLabels?: Record<string, string>;

  diversifiedAddresses?: {
    diversifierIndex: number;
    sharedWith: string;
    address: string;
    sharedAt: number;
  }[];

  autoLockMinutes?: number;

  zafuTheme?: 'sumi' | 'washi' | 'terminal';

  zafuFont?: 'iosevka' | 'system';

  zafuFeeMultiplier?: number;

  proLicense?: string;
  zignerFirmwareRecords?: Record<
    string,
    {
      device: string;
      fw: string;
      slot: 'A' | 'B';
      feature_set: string[];
      applied_at: number;
      source: 'ur:zafu-result';
      session: string;
    }
  >;

  polkadotVaultSettings?: {
    legacyMode: boolean;
  };

  messages?: {
    id: string;
    network: 'penumbra' | 'zcash';
    senderAddress?: string;
    recipientAddress: string;
    content: string;
    txId: string;
    blockHeight: number;
    timestamp: number;
    direction: 'sent' | 'received';
    read: boolean;
    amount?: string;
    asset?: string;
  }[];

  /**
   * Per-chainId HD index counter for burner-address rotation. Rotated on every
   * `nextHdIndex(chainId)` call so unshields from a shielded pool don't reuse
   * the same transparent destination. Absent chain == counter at 0. See
   * `cosmos-chain-counters.ts` for the atomic accessor and the rotation
   * rationale (receiver unlinkability on the unshield path).
   */
  cosmosChainCounters?: CosmosChainCounters;

  /**
   * Per-origin+chain sliding 24 h counter tracking fresh-address requests. The
   * key is `<origin>|<chainId>`; `windowStart` is when the current 24 h window
   * opened, `count` how many derivations that window has served. The rate limit
   * caps at 100 per window per origin per chain, so a hostile site can neither
   * exhaust the HD counter nor loop the derivation function into a DoS.
   */
  cosmosFreshAddressRateLimits?: CosmosFreshAddressRateLimits;
};
