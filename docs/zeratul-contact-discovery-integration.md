# Zeratul (poker-client) integration: ZID contact discovery

How the **zeratul poker client** composes the GENERAL, app-agnostic
`zafu_discover_contacts` primitive that this branch scaffolds in the extension.

This is a **map**, not a change set. Nothing in `zeratul` is modified here. All
`file:line` citations are against the `zeratul` repo as read on 2026-08-19.

## Governing split

- **zafu (extension)** exposes ONE general verb — "which of my contacts are
  present in THIS app right now" — plus a general seal-to-peer path. It knows
  nothing about poker.
- **zeratul (poker-client)** specializes: it decides that a "present contact"
  is a _player you can invite_, that a table has seats, and that an invite says
  _"join table #N"_. All of that vocabulary lives in zeratul, never in zafu.

The primitive contract:

| message                  | in                                         | out                                                                     |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------- |
| `zafu_discover_contacts` | (origin from sender) `epoch?`, `relayUrl?` | `{ epoch, present: [{ handle, displayName? }] }` — matched present only |
| `zafu_discover_seal`     | `handle`, `plaintext` (b64, opaque)        | `{ ciphertext, ephemeral_pubkey }` (same shape as `zafu_encrypt`)       |

`present[].handle` is an app-scoped, epoch-rotating ephemeral id. zeratul feeds
it straight back into `zafu_discover_seal`; it never sees a pubkey or the full
contact list.

---

## (a) Where poker-client calls `zafu_discover_contacts`

The provider layer is where every `chrome.runtime.sendMessage(extId, …)` call to
zafu already lives. Contact discovery slots in beside the existing
`pickContacts` call.

- **Add `discoverContacts()` to the provider**, mirroring `pickContacts`
  (`crates/poker-client/src/zid/provider.ts:85-111`). Same shape: resolve
  `extId` from `zafu.origin` (provider.ts:91), `sendMessage` with
  `{ type: 'zafu_discover_contacts' }`, return `resp.present`. Note the origin is
  NOT sent — zafu reads the browser-attested `sender.origin`, so the
  `appOrigin:` field that `pickContacts` passes (provider.ts:97) is dropped.

- **Surface it on the `ZidIdentity` object** next to `pickContacts`
  (`crates/poker-client/src/zid/types.ts:16`) and wire it in the `zid`
  singleton where `pickContacts` is assembled
  (`crates/poker-client/src/zid/zid.ts:44` for the zafu path, `:88` for the
  ephemeral fallback — discovery has no ephemeral fallback, so it resolves to
  `[]` when `mode !== 'zafu'`).

Semantics contrast for the reader:

- `pickContacts` (provider.ts:85) = "open a picker, user chooses from the whole
  book" — a UI action returning user-selected contacts.
- `discoverContacts` (new) = "no UI, no probing, return only contacts already
  present in this poker app" — a presence query. This is the one to drive the
  lobby's live "who can I invite right now" list.

## (b) Where poker-client renders them in ITS OWN UI

The lobby already models "who is around":

- The **online-players list** in the play tab
  (`crates/poker-client/src/Lobby.tsx:480-495`), backed by the `players` signal
  (Lobby.tsx:125) fed from relay `Players` messages (Lobby.tsx:145), with the
  `{players().length} online` counter (Lobby.tsx:450). Today that is
  _table_ presence from the relay. `discoverContacts` adds a second, orthogonal
  source: _contact_ presence across the poker app — "3 of your friends are here".

- The **invite tab** (`crates/poker-client/src/Lobby.tsx:361-396`) currently
  renders a single "pick from address book" button (Lobby.tsx:367-394) gated on
  `props.identity?.pickContacts` (Lobby.tsx:364). This is the natural home for a
  discovered-friends strip: replace/augment the button with a live list built
  from `identity.discoverContacts()`, each row rendered from
  `{ handle, displayName }` — pure zeratul JSX, no zafu UI involved. The same
  pattern applies to the App-level invite button
  (`crates/poker-client/src/App.tsx:575-595`).

Rendering rule: zeratul owns the row markup, the "invite" affordance, seat
counts, etc. zafu returns data only. The `handle` is display-opaque; show
`displayName` (or a poker-side nickname) to the user.

## (c) Where poker-client seals a "join table #N" invite via the general seal

The existing invite flow (`identity.invite(handle, payload)`) routes through
`sendInvite` (`crates/poker-client/src/zid/provider.ts:115-140`, wired at
`zid.ts:53`) and today returns "not yet implemented" from the extension side.

Recompose it onto the general seal:

1. zeratul builds its OWN payload — the poker semantics — exactly as it already
   does at `crates/poker-client/src/Lobby.tsx:377-381` and
   `crates/poker-client/src/App.tsx:582-586`:

   ```ts
   { type: 'poker-table-invite', data: { name, sb, bb, buyin, url }, ttl: 300 }
   ```

   This object is **opaque to zafu**. "table", "buyin", "join table #N" never
   cross the boundary as structured fields.

2. zeratul JSON-encodes + base64s that payload and calls
   `zafu_discover_seal` with the peer's `handle` and the b64 `plaintext`.
   zafu resolves `handle -> peer session pubkey` internally and returns
   `{ ciphertext, ephemeral_pubkey }` — the SAME sealed-box output as
   `zafu_encrypt`.

3. zeratul delivers the sealed blob over its own transport (the poker relay /
   zid channel at `crates/poker-client/src/zid/channel.ts`, as the current
   fallback path already does at `zid.ts:57-63`). The recipient's poker-client
   opens it and renders the incoming invite (the `onInvite` /
   `listenInvites` seam, provider.ts:143-173).

Net effect: `provider.ts:sendInvite` becomes a thin "seal via zafu, deliver via
our channel" wrapper. No `zafu_send_invite` / poker-specific verb is needed —
that legacy stub (external side) is superseded by the general seal.

## (d) Where refill-escrow stays a separate, zafu-signed request

Escrow is **money**, not discovery, and must stay on its own signed path. It is
already fully separate and should remain so:

- Escrow creation / join / co-sign go through the FROST verbs
  (`crates/poker-client/src/zid/provider.ts:178-251`:
  `frostCreate` :178, `frostJoin` :202, `frostSign` :228), which map to zafu's
  `zafu_frost_*` external API — each behind its own approval popup and, for
  signing, the verified-PCZT `zafu_frost_sign_orchard` path in the extension.
- Escrow is negotiated in-band by the poker service
  (`crates/poker-client/src/negotiate.ts:68` `escrow_ready`, handled at
  `negotiate.ts:87`; surfaced to the relay at
  `crates/poker-client/src/ws.ts:132`) and displayed at
  `crates/poker-client/src/App.tsx:610-617`.

A **refill** (topping up a running table's 2-of-3 escrow) is therefore a
`frostSign` / `frost_sign_orchard`-style **zafu-signed transaction request**,
gated by the `frost` capability and its own per-transaction approval — NOT a
discovery call and NOT a sealed invite. The two never share a code path:

- `discover` + `seal` need only `discover_contacts` consent; they move no funds
  and produce no signatures.
- refill needs `frost` consent and a signature over an inspectable PCZT.

Keeping them distinct means a page that earned "see which friends are here"
consent can never, by that grant, move escrow funds.

---

## Dependency note

The extension side of (a)/(b)/(c) is scaffolded but **inert** until the sibling
modules land and `registerContactDiscoveryService()` is called at
service-worker startup:

- `contact-relay.ts` — broadcast-bucket discovery -> present-friend set
- `presence-blob.ts` — seal/open presence blobs
- `state/contacts.ts` `getContactRootSecret`
- `identity.ts` `deriveZidContactCardKey` / `zidContactRootSecret` / `ContactCardKey`
- `@zafu/zid` `presenceEpoch` / `rendezvousTag` / `ratchetRootSecret`

Until then `zafu_discover_contacts` returns
`{ error: 'contact discovery service not available in this build' }`, so
zeratul can integrate against the contract and degrade gracefully (fall back to
the existing `pickContacts` button) meanwhile.
