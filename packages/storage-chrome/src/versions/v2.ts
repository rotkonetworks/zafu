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
};
