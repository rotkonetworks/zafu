# Zafu Multi-Network Architecture

## Overview

Zafu is the **companion app for Zigner** - an air-gapped cold signing wallet.
The primary flow is:

```
Zafu (Watch-Only)          Zigner (Cold Signer)
      │                           │
      │  1. Import FVK via QR     │
      │◄──────────────────────────│
      │                           │
      │  2. Build unsigned tx     │
      │                           │
      │  3. Show sign request QR  │
      │──────────────────────────►│
      │                           │
      │  4. User approves & signs │
      │                           │
      │  5. Scan signature QR     │
      │◄──────────────────────────│
      │                           │
      │  6. Broadcast tx          │
      └───────────────────────────┘
```

## Supported Networks

| Network | Chain ID | Zigner Module | Status |
|---------|----------|---------------|--------|
| Penumbra | 0x03 | penumbra | ✅ Working |
| Zcash | 0x04 | zcash | ✅ Ready |
| Polkadot | 0x00 | substrate | 🔧 Planned |
| Cosmos | TBD | cosmos | 🔧 Planned |
| Bitcoin | TBD | bitcoin | 🔧 Planned |
| Nostr | TBD | nostr | 🔧 Planned |

## QR Protocol

All QR codes use the format:
```
[0x53][chain_id][tx_type][payload...]

TX Types:
- 0x01: FVK/Key Export (Zigner → Zafu)
- 0x02: Sign Request (Zafu → Zigner)
- 0x03: Signature Response (Zigner → Zafu)
```

## Package Structure

```
packages/wallet/src/
├── index.ts              # Exports
├── wallet.ts             # Base wallet interface
├── custody.ts            # Key custody abstraction
├── airgap-signer.ts      # Generic airgap signing
│
├── networks/             # Network-specific implementations
│   ├── penumbra/
│   │   ├── types.ts
│   │   ├── wallet.ts     # Penumbra wallet
│   │   └── zigner.ts     # Penumbra-Zigner integration
│   │
│   ├── zcash/
│   │   ├── types.ts
│   │   ├── wallet.ts     # Zcash wallet
│   │   └── zigner.ts     # Zcash-Zigner integration (existing zcash-zigner.ts)
│   │
│   ├── polkadot/
│   │   ├── types.ts
│   │   ├── wallet.ts     # Polkadot wallet
│   │   └── zigner.ts     # Polkadot-Zigner integration
│   │
│   └── cosmos/
│       ├── types.ts
│       ├── wallet.ts     # Cosmos wallet
│       └── zigner.ts     # Cosmos-Zigner integration
│
└── common/
    ├── qr.ts             # QR encoding/decoding
    ├── types.ts          # Common types
    └── utils.ts          # Shared utilities
```

## State Structure (Zustand)

```typescript
interface WalletState {
  // Active network
  activeNetwork: NetworkType; // 'penumbra' | 'zcash' | 'polkadot' | 'cosmos'

  // Wallets per network
  wallets: {
    penumbra: PenumbraWallet[];
    zcash: ZcashWallet[];
    polkadot: PolkadotWallet[];
    cosmos: CosmosWallet[];
  };

  // Active wallet index per network
  activeWalletIndex: {
    penumbra: number;
    zcash: number;
    polkadot: number;
    cosmos: number;
  };

  // Pending transactions (awaiting Zigner signature)
  pendingTxs: PendingTransaction[];

  // Actions
  setActiveNetwork: (network: NetworkType) => void;
  addWallet: (network: NetworkType, wallet: AnyWallet) => void;
  createSignRequest: (tx: UnsignedTx) => SignRequest;
  applySignature: (txId: string, signature: SignatureResponse) => void;
}
```

## UI Components

### Network Selector
```
┌─────────────────────────────────┐
│ [🔴 Penumbra ▾]                 │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ ◉ Penumbra                  │ │
│ │ ○ Zcash                     │ │
│ │ ○ Polkadot                  │ │
│ │ ○ Cosmos                    │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

### Send Transaction Flow
```
1. Select recipient
2. Enter amount
3. Review transaction
4. Show QR code (sign request)
5. Scan Zigner response
6. Broadcast
```

### Home Screen Layout
```
┌─────────────────────────────────┐
│ [🔴 Network ▾] [👤 Account ▾]   │
├─────────────────────────────────┤
│                                 │
│ Total Balance                   │
│ $1,234.56                       │
│                                 │
├─────────────────────────────────┤
│ Assets                          │
│ ┌─────────────────────────────┐ │
│ │ ZEC    12.5        $450.00  │ │
│ │ UM     100.0       $200.00  │ │
│ │ DOT    50.0        $300.00  │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ [Send] [Receive] [Scan]         │
└─────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Multi-Network Foundation
- [ ] Create network abstraction layer
- [ ] Add network selector to UI
- [ ] Refactor state for multi-network

### Phase 2: Zcash Integration
- [ ] Complete Zcash wallet implementation
- [ ] Add Zcash send UI
- [ ] Integrate with zafu-wasm for tx building
- [ ] Test full Zigner signing flow

### Phase 3: Polkadot Integration
- [ ] Add Polkadot wallet implementation
- [ ] Add Polkadot send UI
- [ ] Use @polkadot/api for tx building
- [ ] Test Zigner signing flow

### Phase 4: Cosmos Integration
- [ ] Add Cosmos wallet implementation
- [ ] Add Cosmos send UI
- [ ] Use cosmjs for tx building
- [ ] Test Zigner signing flow

## Network-Specific Notes

### Zcash
- Uses ZIP-32 for key derivation
- Orchard shielded pool (RedPallas signatures)
- FVK = 96 bytes
- Unified addresses

### Polkadot
- Uses SLIP-10/BIP32-Ed25519
- Sr25519 or Ed25519 signatures
- Metadata portals for tx decoding
- Multi-chain (relay + parachains)

### Cosmos
- Uses SLIP-10/BIP44
- Secp256k1 signatures
- IBC for cross-chain
- Multi-chain (zones)

### Penumbra
- Uses custom ZK key derivation
- decaf377 signatures
- Shielded by default
