# zigner

zigner is an air-gapped cold wallet companion for zafu. spending keys stay on
the phone. the browser extension holds only viewing keys and cannot authorize
transactions on its own.

## overview

zafu supports two wallet types:

- **mnemonic** - the extension holds the seed phrase (encrypted at rest) and can
  derive spending keys locally. this is a hot wallet.
- **zigner-zafu** - the extension holds only viewing keys imported via QR code
  from a zigner device. transaction signing requires round-trip QR code
  communication with the phone. this is a cold wallet.

the zigner model is the same for all supported networks: penumbra, zcash,
polkadot, and cosmos.

## what stays on the phone

the zigner device (phone) holds:

- the seed phrase / mnemonic
- spending keys derived from the seed
- authorization to sign transactions

the zigner device never connects to the internet during signing. the air gap
is maintained by using QR codes as the only communication channel.

## what the extension holds

for a zigner-zafu vault, the extension stores:

- **penumbra**: the full viewing key (FVK), account index, device identifier
- **zcash**: the orchard full viewing key or unified full viewing key (UFVK),
  account index, device identifier
- **polkadot**: the SS58 address and genesis hash (watch-only)
- **cosmos**: chain addresses and optionally a compressed secp256k1 public key
  (watch-only)

viewing keys allow the extension to:

- derive receiving addresses
- decrypt and scan incoming transactions
- display balances and transaction history
- build unsigned transactions

viewing keys do not allow:

- signing transactions
- moving funds
- authorizing spends

## import flow

importing a zigner wallet into the extension:

1. on the zigner device, export the viewing key as a QR code
2. in the extension, open settings > wallets > scan zigner QR
3. the extension camera scans the QR code
4. the extension parses the QR data and extracts the viewing key
5. the user optionally sets a label
6. the extension stores the viewing key in an encrypted vault entry

the extension accepts multiple QR formats:

- **UR format** (preferred) - `ur:penumbra-accounts/...` or
  `ur:zcash-accounts/...`. uses the uniform resources encoding standard.
- **legacy binary format** - hex-encoded binary with a `0x53` prefix byte,
  chain byte (`0x03` for penumbra, `0x04` for zcash), and operation byte
  (`0x01` for FVK export).
- **substrate format** - `substrate:<address>:<genesis_hash>` for
  polkadot/kusama watch-only addresses.
- **cosmos JSON format** - JSON with `type: "cosmos-accounts"`, containing
  chain addresses and a public key.

## signing flow

sending a transaction with a zigner wallet:

1. the extension builds an unsigned transaction
2. the extension encodes the sign request as a QR code and displays it
3. the user scans the QR code with the zigner device
4. the zigner device displays the transaction details for review
5. the user approves on the zigner device
6. the zigner device signs and displays a QR code containing the signature
7. the user scans the signature QR code with the extension
8. the extension attaches the signature to the transaction and broadcasts it

the signing state machine tracks these steps:

`idle` - `building` - `show_qr` - `scanning` - `broadcasting` - `complete`

if any step fails, the state transitions to `error` and can be reset.

## balance sync

for zcash zigner wallets, the extension can sync balance data back to the
zigner device via QR code. this lets the phone display current balances without
connecting to the network.

## security model

the air gap provides the following properties:

- **compromise of the extension** (browser exploit, malicious site, compromised
  machine) does not expose spending keys. an attacker gains viewing access
  (transaction history, balances) but cannot move funds.
- **compromise of the phone** while offline does not expose funds to network
  attackers. the phone must be physically accessed.
- **the QR code channel** is unidirectional per step and contains only the
  minimum data needed (sign request or signature). no persistent connection is
  established.
- **transaction review** happens on the zigner device, which shows the
  destination and amount before signing. a compromised extension cannot silently
  redirect funds without the user seeing the wrong address on the phone screen.

## vault type

zigner wallets are stored as vault entries with `type: 'zigner-zafu'`. the
`ZignerZafuImport` type contains optional fields for each network's key
material. a single zigner import can contain keys for multiple networks.

insensitive metadata (device ID, account index, network addresses) is stored
in the vault's `insensitive` record. the viewing key data is encrypted at rest
alongside all other wallet data.
