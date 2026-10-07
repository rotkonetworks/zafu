export { type LOCAL, type SYNC, type VERSION };

type VERSION = 5;

type SYNC = void;

type BoxJson = { cipherText: string; nonce: string };

/**
 * v4 drops Polkadot/Kusama/Substrate support entirely (zafu is zcash +
 * penumbra + cosmos/ibc + ethereum/bitcoin going forward). Removed vs v3:
 *
 *   - `activeNetwork`, `enabledNetworks`, `networkEndpoints`,
 *     `contacts[].addresses[].network`, `recentAddresses[].network`: no
 *     longer accept `'polkadot' | 'kusama'`.
 *   - `polkadotZignerAccounts`, `activePolkadotZignerIndex`,
 *     `enabledParachains`, `customChainspecs`, `polkadotVaultSettings`:
 *     removed, Polkadot-only.
 *   - `zignerWallets[].networks.polkadot`: removed; the rest of a legacy
 *     zigner wallet record (penumbra/zcash/cosmos) is unaffected.
 *
 * The v3->v4 migration strips these fields and values out of existing data
 * rather than deleting anything that also holds zcash/penumbra/cosmos state.
 * See migrations/local-v3-v4.ts.
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
        /** per-sender monotonic counter (absent on threads written by older builds) */
        seq?: number;
      }[];
      /** highest accepted counter per lowercased sender pubkey - the replay guard */
      sendCounters?: Record<string, number>;
    }
  >;
  activeWalletIndex?: number;
  backupReminderSeen?: boolean;
  seedPhraseBackedUp?: boolean;
  keplrCompat?: boolean;
  /**
   * Per-capability participation switch, keyed by `Capability` (see
   * @repo/storage-chrome/capabilities). An absent capability is `unset`, which
   * is NOT the same as `disabled`: unset means the first site that asks gets
   * the one-time opt-in prompt; disabled refuses without asking. Written by the
   * opt-in prompt via state/capability-modes.ts, read by the worker's gate
   * filter (message/listen/gate.ts).
   */
  capabilityModes?: Record<string, 'enabled' | 'disabled'>;
  /**
   * Outbound-destination ledger: one entry per host zafu has ever contacted,
   * with the user's decision on it. The shape is owned by
   * `apps/extension/src/net/destination.ts` and parsed defensively on read, so
   * it is declared loosely here rather than duplicating the record in the
   * storage package. Absent map == nothing recorded yet.
   */
  netEgress?: unknown;
  /**
   * Networks the user added manually (endpoint for a chain zafu does not ship).
   * Shape is owned by `apps/extension/src/net/custom-networks.ts`; these hosts
   * are part of the trusted egress inventory.
   */
  customNetworks?: unknown[];
  /** bounded audit trail (who zafu called, when, why); see `net/destination.ts` */
  netEgressLog?: unknown[];
  /** legacy global penumbra birthday; adopted per wallet into `penumbraStarts` */
  compactFrontierBlockHeight?: number;
  frontendUrl?: string;
  /** legacy global penumbra height; superseded by `penumbraSync` */
  fullSyncHeight?: number;
  /**
   * Where each penumbra wallet's sync starts, by stringified WalletId (already
   * plaintext in its IndexedDB name). `tip` and `since` (ms epoch, 0 = the
   * start of the chain) are what the ui asks for; the worker resolves them
   * against the node's tip into `creation` (no trial decryption below it) and
   * `frontier` (a fresh wallet may start from the tip snapshot). Absent: not
   * known yet, the worker waits and the home asks once.
   */
  penumbraStarts?: Record<
    string,
    'tip' | { since: number } | { creation: number; frontier?: number }
  >;
  /** what the running penumbra sync publishes for the home: one wallet at a time */
  penumbraSync?: {
    walletId: string;
    height?: number;
    from?: number;
    /** sync stopped because local data could not be read or written (reload to retry) */
    stopped?: 'storage';
  };
  grpcEndpoint?: string;
  params?: string;
  passwordKeyPrint?: { hash: string; salt: string };
  /** legacy global penumbra birthday; adopted per wallet into `penumbraStarts` */
  walletCreationBlockHeight?: number;
  zignerCameraEnabled?: boolean;
  cosmosAddressIndex?: number;
  approvalsInSidePanel?: boolean;
  /** supersedes approvalsInSidePanel; see apps/extension side-panel-pref.ts */
  approvalSurface?: 'hybrid' | 'sidebar' | 'popup';
  clearingCache?: boolean;
  pendingClearCache?: ('penumbra' | 'zcash')[];
  /** 'zcash', 'penumbra', or a penumbra subnetwork's chain-registry name */
  activeNetwork?: string;
  zcashWallets?: {
    id: string;
    label: string;
    orchardFvk: string;
    address: string;
    transparentAddress?: string;
    accountIndex: number;
    mainnet: boolean;
    vaultId?: string;
    coldSignerType?: 'zigner' | 'keystone' | 'ledger' | 'viewing-key';
    /** `uview1...`: zigner, keystone and shielded Ledger imports */
    ufvk?: string;
  }[];
  activeZcashIndex?: number;
  zignerWallets?: {
    id: string;
    label: string;
    zignerAccountIndex: number;
    importedAt: number;
    networks: {
      penumbra?: { fullViewingKey: string; address: string };
      zcash?: { orchardFvk: string; unifiedAddress: string; mainnet: boolean };
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
  /**
   * v5 split v4's `enableBackgroundSync`, which meant two things: penumbra's
   * "keep syncing when closed" (read `=== true`) and the transparent-chain
   * background switch (read `!== false`).
   */
  privacySettings?: {
    enableTransparentBalances: boolean;
    enableTransactionHistory: boolean;
    /** keep penumbra syncing after the last zafu window closes; default false */
    keepPenumbraSyncing: boolean;
    /** transparent (cosmos) chains may be polled in the background; default false */
    transparentBackgroundSync: boolean;
    enablePriceFetching: boolean;
  };
  /** as activeNetwork: any cosmos chain the penumbrafi registry lists can be here */
  enabledNetworks?: string[];
  networkEndpoints?: {
    penumbra?: string;
    zcash?: string;
    noble?: string;
    cosmoshub?: string;
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
  /** what each zcash node said it is (GetLightdInfo vendor), keyed by its url */
  zcashBackends?: Record<string, 'zidecar' | 'lightwalletd'>;

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
      network: 'penumbra' | 'zcash' | 'cosmos' | 'ethereum' | 'bitcoin';
      address: string;
      chainId?: string;
      notes?: string;
      lastUsedAt?: number;
    }[];
  }[];

  recentAddresses?: {
    address: string;
    network: 'penumbra' | 'zcash' | 'cosmos' | 'ethereum' | 'bitcoin';
    chainId?: string;
    useCount: number;
    lastUsedAt: number;
    firstUsedAt: number;
  }[];

  dismissedContactSuggestions?: string[];

  zidPreferences?: Record<
    string,
    {
      mode: 'cross-site' | 'site';
      rotation: number;
      identity: string;
      /** "friends can find you here" for this site; absent = off */
      findFriends?: boolean;
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
    /** empty means DEFAULT_CONTACT_DISCOVERY_RELAY (config/contact-discovery-relay) */
    relayEndpoint: string;
    relayToken?: string;
  };

  zidSiteLabels?: Record<string, string>;

  /** the people relay: the default for new rooms and cards, and the other relays allowed */
  peopleRelay?: {
    /** blank means https://relay.zafu.pro (config/people-relay) */
    endpoint?: string;
    hosts?: string[];
  };

  diversifiedAddresses?: {
    diversifierIndex: number;
    sharedWith: string;
    address: string;
    sharedAt: number;
  }[];

  /**
   * the passwords tool's saved logins: what to put back in its form, never a
   * password. sealed at rest (ENCRYPTED_KEYS); `owner` is the wallet's zid or
   * vault id, since each wallet's phrase derives its own passwords.
   */
  passwordLogins?: {
    owner: string;
    site: string;
    username: string;
    length: number;
    version: number;
    savedAt: number;
  }[];

  /**
   * which wallet made a passkey for which relying party, from which origin:
   * a site may only ask to sign in to an rpId it created a passkey for.
   * sealed at rest (ENCRYPTED_KEYS); `owner` is the wallet's zid or vault id.
   */
  passkeyGrants?: {
    origin: string;
    rpId: string;
    owner: string;
    /** the account's user id (hex), for a passkey made per account */
    userId?: string;
    at: number;
  }[];

  /**
   * your own addresses on other chains, per wallet (owner = zid or vault id),
   * offered again in swap fields. sealed at rest (ENCRYPTED_KEYS).
   */
  yourAddresses?: {
    owner: string;
    chain: string;
    address: string;
    savedAt: number;
  }[];

  autoLockMinutes?: number;

  zafuTheme?: 'sumi' | 'washi' | 'terminal';

  zafuFont?: 'iosevka' | 'system';

  /** the transparent chains whose nodes the user agreed may be asked for balances */
  transparentAgreed?: string[];

  /** transparent chains the user hid from the penumbra home */
  hiddenTransparentChains?: string[];

  /** what the penumbra home's total is shown in; absent = usd */
  penumbraTotalIn?: 'usd' | 'um';

  /** penumbra home rows (asset ids, base64) the user turned to show usd */
  penumbraRowsInUsd?: string[];
  /** the swap route the user chose per pair (`into_zec:btc@btc`), kept only when they changed it */
  swapRoutes?: Record<string, 'near' | 'thor' | 'maya' | 'penumbra'>;
  /** the custodial swap routes the person has acknowledged once (a solver holds funds in flight) */
  swapCustodyAck?: ('near' | 'thor' | 'maya' | 'penumbra')[];
  /** the pair the swap screen reopens on, per wallet (a ui convenience, not a setting) */
  swapLast?: Record<
    string,
    {
      direction: 'into_zec' | 'from_zec';
      token?: { symbol: string; chain: string; decimals: number; usd?: number };
    }
  >;

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

  /**
   * Ledger-signed transactions not yet settled, by operation id (see
   * apps/extension src/ledger/zcash-app/operations-store.ts). The signed bytes
   * are sealed with the vault key; the metadata stays readable so recovery can
   * list work while locked. A password change re-seals them with the vaults.
   */
  zafuLedgerSignedOperations?: Record<
    string,
    {
      meta: {
        operationId: string;
        walletId: string;
        network: 'main' | 'test';
        kind: 'send' | 'shield';
        state: 'signed' | 'broadcast_uncertain' | 'broadcast' | 'acknowledged';
        txid?: string;
        label?: string;
        message?: string;
        createdAt: number;
        updatedAt: number;
      };
      sealed: string;
    }
  >;
};
