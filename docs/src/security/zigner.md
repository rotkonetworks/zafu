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

zigner covers zcash and penumbra. zcash transactions are signed in the send
flow (a PCZT); penumbra transactions in the dapp approval flow (a transaction
plan). the `zigner-zafu` vault type is shared with other wallets that hold no
seed, told apart by `coldSignerType`: `zigner`, `keystone`, `ledger`, and
`viewing-key` (a watch-only wallet with no signer, never offered a send). this
page describes zigner.

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

1. on the zigner device, show the viewing key as a QR code
2. in zafu, add a wallet and scan it (settings › wallets and devices). there is
   one scanner for every signer; zafu tells a zigner from a keystone by the
   code itself (a zigner code carries its zid), and a code can be pasted
   instead of scanned
3. zafu reads the viewing key, you may name the wallet, and it is stored
   sealed at rest

one code carries one network. scanning the same zigner's code for the other
network joins the same wallet rather than making a second one.

accepted formats:

- **UR** (preferred) - `ur:zcash-accounts/...` or `ur:penumbra-accounts/...`
- **legacy binary** - a `0x53` prefix byte, a chain byte (`0x03` penumbra,
  `0x04` zcash) and `0x01` for a viewing key export, from older zigner
  firmware

## signing flow

sending a zcash transaction with a zigner wallet:

1. zafu builds an unsigned PCZT (partially created zcash transaction) and
   strips what the signer can work out itself, including the viewing key, so
   the QR carries no key that could read your history
2. zafu shows the request as an animated QR code (`ur:zigner-module` frames)
3. you scan it with zigner, which shows the recipient, amount and fee
4. you approve on zigner, which signs and shows only the signatures as a QR
5. zafu scans them, merges them into the PCZT it kept, checks the result, and
   broadcasts it

an older zigner that does not know the compact request gets the full PCZT
(`ur:zcash-pczt`) and answers with the full signed PCZT. shielding transparent
funds uses that full form too.

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
