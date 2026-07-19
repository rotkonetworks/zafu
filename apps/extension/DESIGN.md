# zafu UI design guide

The wallet has one voice and one visual language. New screens match this by
reference, not by taste. When in doubt, copy `routes/page/onboarding/start.tsx`
(page) or `routes/popup/send/ironwood-migrate.tsx` (popup) - both are canonical.

## Voice

- **lowercase.** Headers, labels, buttons, empty states - all lowercase.
  `balance`, not `Balance`. `review transaction`, not `REVIEW TRANSACTION`.
  `approve` / `deny`, not `Approve` / `Deny`.
- **Exceptions (keep original case):** proper nouns and acronyms - Penumbra,
  Zcash, Zafu, Zigner (as product name mid-sentence it may stay lowercase to
  match brand), Cosmos, Polkadot, Keystone, Orchard, Ironwood, IBC, FROST, QR,
  ZEC, UM, RPC, MIT, ZIP-317. Never lowercase these into meaninglessness.
- **terse. one idea per line.** No explainer paragraphs (3+ sentences on how a
  feature works). Replace prose with: a labeled key/value row, one tight line,
  or an icon. If you're writing "this builds a transaction that spends..." or
  "these values are read from...", delete it.

## Layout

- Screens render inside a provided shell/pane. Do NOT wrap a screen in a
  standalone `<Card className='w-[NNNpx]' gradient>` - that is the retired
  pattern. Use `flex flex-col gap-{4,5,6}` inside the shell.
- Structure: header (`shrink-0`) -> scroll region (`min-h-0 flex-1 overflow-y-auto`)
  -> optional sticky footer (`shrink-0`) for the primary action.
- Screen-edge padding is `p-4`. Don't vary it per step.

## Headers (scale is context-dependent)

- **Popup** (400px, e.g. send / approval / migrate steps):
  `<h2 className='text-lg font-medium'>lowercase title</h2>`.
- **Page** (full-tab, e.g. onboarding):
  `<h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>` + one
  `<p className='text-xs lowercase text-fg-muted'>` subline.
- Never `<CardTitle>`. Never Title Case.

## Iconography

- UnoCSS lucide only: `<span className='i-lucide-NAME h-4 w-4' />`. **No emojis**
  anywhere in UI (memo/message _content_ strings are protocol data, not UI).
- Use icons to carry meaning words don't need: steps (`smartphone -> scan ->
check`), states, warnings (`triangle-alert`), pool/network markers.

## Tokens (never ad-hoc)

- **Color:** `text-fg-high` / `text-fg-muted` / `text-fg-dim`; `bg-elev-1/2/3`;
  `border-soft`; `network-accent`; `zigner-gold`. Not `text-muted-foreground`,
  not raw `text-gray-*`, not per-state `text-green-500` (use fg-high/muted for
  on/off; reserve red/yellow for genuine error/warning semantics).
- **Type:** `text-display` (hero number) / `text-title` / `text-data` /
  `text-label` / `kicker`. Amounts use `tabular` / `tabular-nums`.
- **Buttons:** the `@repo/ui` `<Button>` component (`variant='gradient'|'secondary'`),
  not ad-hoc `border + bg-*` spans.
- **Spacing:** `gap-2/2.5/3/4/5/6`, `rounded-md/lg`. Consistent, no magic values.

## Privacy

- On-screen amounts wrap in `<Sensitive>` (components/sensitive.tsx) so the
  hide-balances toggle blurs them.

## Taste

Restraint. Big number, small label. Choices are cards with an icon + a one-line
hint, not walls of text or button rows. Consistent hover (`hover:bg-elev-1`) and
transitions. Fewer words, stronger hierarchy.
