# Editorial primitives

Typography-first surface pieces that extend the v2 design system.
Use the preview HTMLs in `packages/ui/docs/design-preview/` as the spec.

## When to reach for each

### `<Masthead>`
The newspaper-style title row: kicker + h1 + right-aligned meta.
Use on: **long-form / documentary surfaces** — the subscribe plan detail
page, an upcoming stats/activity page, the internal /docs route, a
standalone receipt view. It expects room to breathe (≥640px width). Not
the right fit for the popup's 400px operational screens; those use
`AppHeader` + per-section `kicker` labels instead.

### `<SectionHead>`
The numbered section rule: `[ 01 | section label | ─────── ]` with an
optional row-2 hint. Same guidance as `Masthead` — works beautifully on
a long scrolling page with five+ sections ("01 surfaces", "02 ink",
"03 brand"). On a 400px popup with two or three groupings, the numbered
column reads as ornamental; prefer a bare `kicker` there.

### `<Glass>`
The translucent dark panel with gold-tinted top rim. Reserved for
"about-to-commit" surfaces: approval sheets, signing review, escrow
confirmations. Overusing Glass makes it stop meaning anything — keep
it load-bearing.

### `<Rule>`
1px hairline divider. Fine anywhere.

### `<RulerScale>`
Drawn spacing-ruler visualisation. Intended for internal docs /
storybook, not production UI.

## Current adoption

As of v2 landing:
- `kicker` class: used widely (balance labels, confirmation headers,
  masthead-lite variants across popup screens).
- `section-label`, `tabular`, `rule` classes: adopted per the polish
  passes in routes/popup/** and components/**.
- `<Masthead>`, `<SectionHead>`, `<Glass>`, `<RulerScale>` components:
  exported but not yet consumed by app code. They're available for
  future surfaces that match the criteria above — don't force-adopt
  them into the popup just because they exist.

## References

- `packages/ui/docs/design-preview/brand.html` — wordmark, clear-space,
  lockup rules
- `packages/ui/docs/design-preview/colors.html` — surfaces, ink, brand,
  chain accents, semantic
- `packages/ui/docs/design-preview/components.html` — glass primitive,
  section headers, buttons in context
- `packages/ui/docs/design-preview/spacing.html` — drawn ruler, radii
  table, shadow/focus recipes
- `packages/ui/docs/design-preview/type.html` — type scale, metrics,
  numeric display, address rendering
- `packages/ui/styles/globals.css` — canonical token source of truth
- `packages/tailwind-config/index.css` — Tailwind `@theme` registration
  and `@utility` shortcuts (`kicker`, `section-label`, `tabular`, `rule`)
