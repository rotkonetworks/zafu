# Zafu: Zigner-First Multi-Network Wallet

## Core Philosophy

**Every wallet in Zafu is a Zigner wallet.**

Unlike Keplr which stores keys in the browser, Zafu is purely a **watch-only companion** for Zigner. All private keys stay on the air-gapped Zigner device.

## Key Differences from Keplr

| Aspect | Keplr | Zafu |
|--------|-------|------|
| Key Storage | Browser extension | Never - Zigner only |
| Wallet Creation | In extension | In Zigner, import via QR |
| Signing | In extension | QR to Zigner, scan signature back |
| Security Model | Hot wallet | Cold wallet (air-gapped) |
| Network Support | Cosmos ecosystem | Multi-chain (Zcash, Penumbra, Polkadot, Cosmos) |

## Data Model

### ZignerWallet - The Core Type

```typescript
interface ZignerWallet {
  // Identity
  id: string;                    // Unique ID
  label: string;                 // User-defined name

  // Zigner origin
  zignerAccountIndex: number;    // Account index on Zigner device
  importedAt: number;            // When imported from Zigner

  // Network-specific viewing keys (all watch-only)
  networks: {
    penumbra?: {
      fullViewingKey: string;    // bech32m FVK
      address: string;           // Default address
    };
    zcash?: {
      orchardFvk: string;        // 96 bytes hex
      unifiedAddress: string;    // u1...
      mainnet: boolean;
    };
    polkadot?: {
      publicKey: string;         // 32 bytes hex
      ss58Address: string;       // SS58 encoded
      scheme: 'sr25519' | 'ed25519';
    };
    cosmos?: {
      publicKey: string;         // secp256k1 pubkey
      address: string;           // bech32
      chains: string[];          // enabled chain IDs
    };
  };
}
```

### Why This Works

1. **One Zigner account = One Zafu wallet**
   - Account index 0 on Zigner → Wallet 0 in Zafu
   - Each account can have keys for multiple networks

2. **Import once, use everywhere**
   - Scan FVK QR from Zigner
   - Zafu detects which network (from QR chain ID)
   - Adds that network's viewing key to the wallet

3. **Sign any network via same flow**
   - Build unsigned tx in Zafu
   - Show QR with sign request
   - User scans with Zigner camera
   - Zigner shows tx details, user approves
   - Zigner displays signature QR
   - Zafu scans signature, broadcasts

## UI Structure

### Home Screen
```
┌─────────────────────────────────────┐
│ [Wallet 0 ▾]              [⚙️]      │
│ "My Zigner Wallet"                  │
├─────────────────────────────────────┤
│                                     │
│ Total Balance                       │
│ $1,234.56                           │
│                                     │
├─────────────────────────────────────┤
│ Networks                            │
│ ┌─────────────────────────────────┐ │
│ │ 💛 Zcash      12.5 ZEC  $450   │ │
│ │ 🔴 Penumbra   100 UM    $200   │ │
│ │ 🔵 Polkadot   50 DOT    $300   │ │
│ │ ⚛️ Cosmos     25 ATOM   $280   │ │
│ │                                 │ │
│ │ [+ Add Network from Zigner]     │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ [📤 Send]  [📥 Receive]  [📷 Scan] │
└─────────────────────────────────────┘
```

### Wallet Switcher
```
┌─────────────────────────────────────┐
│ Select Wallet                       │
├─────────────────────────────────────┤
│ ◉ Wallet 0 - "Main Zigner"          │
│   💛🔴🔵 (3 networks)               │
│                                     │
│ ○ Wallet 1 - "Cold Storage"         │
│   💛 (1 network)                    │
│                                     │
│ ○ Wallet 2 - "DeFi Account"         │
│   🔴⚛️ (2 networks)                  │
├─────────────────────────────────────┤
│ [+ Import New Wallet from Zigner]   │
└─────────────────────────────────────┘
```

### Add Network to Wallet
```
┌─────────────────────────────────────┐
│ Add Network to "Main Zigner"        │
├─────────────────────────────────────┤
│                                     │
│ On your Zigner device:              │
│                                     │
│ 1. Go to Key Details                │
│ 2. Select the network to add        │
│ 3. Tap "Export Viewing Key"         │
│ 4. Scan the QR code below           │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │                                 │ │
│ │      [Camera Viewfinder]        │ │
│ │                                 │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Detected: Waiting for QR...         │
└─────────────────────────────────────┘
```

### Send Flow (Zigner-Centric)
```
Step 1: Build Transaction
┌─────────────────────────────────────┐
│ Send Zcash                          │
├─────────────────────────────────────┤
│ From: Main Zigner (Account 0)       │
│ Network: 💛 Zcash Mainnet           │
│                                     │
│ To: [u1address...]                  │
│ Amount: [1.5] ZEC                   │
│ Fee: 0.0001 ZEC                     │
│                                     │
│ [Continue →]                        │
└─────────────────────────────────────┘

Step 2: Sign with Zigner
┌─────────────────────────────────────┐
│ Sign with Zigner                    │
├─────────────────────────────────────┤
│                                     │
│ ┌─────────────────────────────────┐ │
│ │      [QR CODE - Sign Request]   │ │
│ │                                 │ │
│ │         530402...               │ │
│ └─────────────────────────────────┘ │
│                                     │
│ 1. Open Zigner camera               │
│ 2. Scan this QR code                │
│ 3. Review & approve on Zigner       │
│ 4. Tap "Scan Signature" below       │
│                                     │
│ [📷 Scan Signature from Zigner]     │
└─────────────────────────────────────┘

Step 3: Scan Signature
┌─────────────────────────────────────┐
│ Scan Signature                      │
├─────────────────────────────────────┤
│                                     │
│ Point camera at Zigner screen:      │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │      [Camera Viewfinder]        │ │
│ │                                 │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Waiting for signature QR (530403)   │
└─────────────────────────────────────┘

Step 4: Broadcast
┌─────────────────────────────────────┐
│ Transaction Signed! ✓               │
├─────────────────────────────────────┤
│                                     │
│ Sending 1.5 ZEC to u1abc...         │
│                                     │
│ [Broadcast Transaction]             │
│                                     │
│ [Cancel]                            │
└─────────────────────────────────────┘
```

## State Structure

```typescript
interface ZafuState {
  // All wallets (each from Zigner)
  wallets: ZignerWallet[];

  // Currently active wallet index
  activeWalletIndex: number;

  // Pending transactions awaiting Zigner signature
  pendingTransactions: PendingTransaction[];

  // Per-network sync state
  syncState: {
    penumbra?: { height: number; syncing: boolean };
    zcash?: { height: number; syncing: boolean };
    polkadot?: { height: number; syncing: boolean };
    cosmos?: { height: number; syncing: boolean };
  };

  // Per-network RPC endpoints
  endpoints: {
    penumbra?: string;
    zcash?: string;
    polkadot?: string;
    cosmos?: string;
  };
}

interface PendingTransaction {
  id: string;
  network: NetworkType;
  walletId: string;
  signRequest: string;        // QR hex to show
  summary: string;            // Human readable
  createdAt: number;
  status: 'awaiting_signature' | 'signed' | 'broadcasting' | 'confirmed' | 'failed';
  signature?: string;         // Filled after scanning
  txHash?: string;            // Filled after broadcast
}
```

## QR Protocol Summary

All QR codes use: `[0x53][chain_id][op_type][payload]`

| Network | Chain ID | FVK Export | Sign Request | Signature |
|---------|----------|------------|--------------|-----------|
| Polkadot Sr25519 | 0x00 | 530001 | 530002 | 530003 |
| Polkadot Ed25519 | 0x01 | 530101 | 530102 | 530103 |
| Penumbra | 0x03 | 530301 | 530302 | 530303 |
| Zcash | 0x04 | 530401 | 530402 | 530403 |

## Implementation Priority

1. **Phase 1: Core Wallet Management**
   - [ ] ZignerWallet data model
   - [ ] Wallet list UI with network badges
   - [ ] Import wallet via FVK QR scan
   - [ ] Wallet switcher

2. **Phase 2: Zcash Complete Flow**
   - [ ] Zcash balance display
   - [ ] Zcash send transaction builder
   - [ ] Sign request QR display
   - [ ] Signature QR scanner
   - [ ] Broadcast to lightwalletd

3. **Phase 3: Penumbra Integration**
   - [ ] Penumbra FVK import
   - [ ] Penumbra balance sync
   - [ ] Penumbra send flow

4. **Phase 4: Polkadot Integration**
   - [ ] Polkadot account import
   - [ ] Polkadot balance display
   - [ ] Polkadot extrinsic signing

5. **Phase 5: Cosmos Integration**
   - [ ] Cosmos account import
   - [ ] Multi-chain support
   - [ ] Cosmos tx signing
