# AGENTS.md - Zafu (rotkonetworks/zafu)

How to work in this repo, for humans and coding agents alike. Read all of it
before your first change. The short version: write less, say less, connect to
less, and prove it works.

## 1. Less code

- Every change should leave the codebase smaller or clearly justify why not.
  State lines added and removed in the PR.
- A new shared component lands only if it replaces two or more existing
  implementations. Delete the old ones in the same change.
- Delete what a change makes dead: unused files, flags, branches, exports,
  styles. No commented-out code.
- No speculative abstraction, no wrapper that only renames, no options nobody
  passes. Three similar lines beat a premature helper.
- Prefer data (maps, tables) over chains of conditionals.

## 2. Reactive code, the compact way

React 19 + zustand, written in the fine-grained spirit of SolidJS:

- **Derive, don't sync.** A value computable from state or props is computed
  inline or in a selector, never mirrored with `useState` + `useEffect`.
- **Effects only for the outside world:** chrome APIs, workers, timers,
  network, subscriptions.
- **Smallest subscriptions:** `useStore(s => s.x.y)`, `useShallow` for
  multi-field picks, subscriptions pushed down into the leaf that reads them.
- **One source of truth.** No duplicated state across components or slices.
- No reflexive `useMemo` / `useCallback` / `memo`; only on a real hot path.
- Pure logic lives in plain, unit-tested functions outside components.
  Composition (children, slots) over boolean prop explosions.
- Async state (loading, error, value) lives in one place per resource.

## 3. Structure: your server as a function

Following Marius Eriksen's "Your Server as a Function": the app is a
composition of small functions, not a pile of conditionals.

- **Services are functions.** A service takes a request and returns a
  response (or a promise of one): `(req) => Promise<rep>`. Keep them pure
  where possible and give them typed inputs and outputs.
- **Cross-cutting concerns are filters** wrapped around a service: timeout,
  retry, egress policy, logging, auth, rate limits. A filter is
  `(req, next) => rep`. Compose filters; don't repeat that logic inside
  each service.
- **Polymorphism over branch cascades.** When behaviour varies by wallet
  type, network or device, define one interface and give each case its own
  implementation. The caller picks an implementation and never runs an
  `if (zigner) ... else if (ledger) ...` chain. For example:
  - signing is one service, `pczt -> signatures`. Hot seed, zigner and
    keystone (QR), ledger (USB) and frost are implementations; the
    transport is a filter.
  - the zcash backend (zidecar or lightwalletd) sits behind one client
    interface.
  - each network (zcash, penumbra, cosmos chains) implements the same send,
    receive and balance contract, so screens don't special-case networks.
- **New behaviour means a new implementation or a new filter,** not another
  branch in an existing function. If a function grows a third `if` on the
  same discriminator, it wants to be polymorphic.
- Each service and filter is unit-testable on its own; compose them in one
  place where the wiring is visible.

## 4. No unnecessary network calls

zafu is a privacy wallet. It contacts only what the user's enabled networks
strictly need (for a zcash-only user: the zcash light client), and nothing
else until the user opts in.

- All traffic goes through the egress wrapper (`apps/extension/src/net/`).
  Never patch around it; never call `fetch` or `WebSocket` outside it.
- Optional destinations ask first (`requestEgressOptIn`), at the moment of use.
- No remote images, fonts, icons or favicons. Bundle them, or use a
  generated monogram.
- No speculative prefetch, speed checks or polling for features that are off.
- No analytics or telemetry of any kind.

## 5. The way zafu speaks (all UI copy)

Calm, polite and honest, like good hospitality. Politeness is tone, not length.

- Lowercase, short, one line. Explanations wait until asked for.
- Errors own the problem and never blame the user. Say what zafu already did
  and offer the next step gently.
  - not "wrong password" but "that doesn't match · please try again, slowly"
  - not "zafu hit a snag" but "something broke on our side, not yours. nothing was lost."
- Declines are soft: "not now", "no, thank you", "don't sign". Never a bare "no".
- Say plainly what others can see (the relay sees you are online; a pool move
  shows the amount). No fake progress, no fake numbers.
- No slang, no exclamation marks, no emojis.

## 6. Design rules

- Square corners, 1px lines, no shadows, no gradients, one gold primary per screen.
- Nothing expands in place: use a Sheet, a new step or a fixed-height StatusSlot.
- Use the shared primitives in `packages/ui/components/ui/` (Button, Sheet,
  Row/RowGroup, Toggle, Segmented, StatusSlot, StepList, CopyButton, Mark).
  Never a raw button with hand-written colours.
- Colours come from the theme variables in `packages/ui/styles/globals.css`.
  Exactly two themes: sumi (dark, default) and washi (light). Never hardcode
  a colour, except the brand seal (fixed vermillion with a cream 匿).
- Icons are UnoCSS CSS classes (`i-ph-*`, `i-lucide-*`), never icon React
  components and never emoji.
- Never offer copy for a seed phrase.
- Every user-settable field goes into the encrypted PersonalDataBackup and
  its restore.
- The design source of truth is the zafu redesign canvas, where the
  maintainers point you to it.

## 7. Writing style in code and commits

- Comments say why, not what. No narrating comments ("this function
  handles..."), no banners, no restating the code.
- No `console.log` left behind; use the existing loggers.
- Never use the em dash character anywhere (code, comments, copy, docs,
  commit messages). Use " - ".
- Commits are small and reviewable, one concern each, in conventional form:
  `type(scope): what changed, in lowercase` - e.g.
  `fix(settings): don't pin the built-in discovery relay as a user choice`.
  Types: feat, fix, refactor, style, test, docs, chore, ci, release.
- The subject says what changed for the user or the code, not how hard it
  was. The body (when needed) says why, what was verified, and the line count
  for reductions.
- Never commit or push secrets, keys, seed phrases or local `dist/` builds.
- AI-assisted commits end with a `Co-Authored-By:` trailer for the model.

## 8. Verify before you say done

Run from the repo root unless noted. Turbo caches can false-green, so use
`--force` where turbo is involved.

- `pnpm -w exec tsc --noEmit -p apps/extension`
- `pnpm lint` in `apps/extension`, and `pnpm -w exec prettier --check .`
- `pnpm vitest run` in `apps/extension` (never lower the passing count)
- prod and beta builds (`webpack.prod-config.ts`, `webpack.beta-config.ts`)
- load `dist/` and `beta-dist/` unpacked (headless is fine) and confirm the
  popup actually renders with no page errors, in both themes
- for money-moving code: tests that prove the funds path (account, change,
  fee), not just that it compiles

Report failures verbatim. If you could not verify something, say so.

## Zafu's version is the Chrome extension version: 25.x.y

It's a browser extension (not a mobile app). The user-facing release number is
the Chrome manifest `version`.

## The app version is mirrored in exactly THREE source files

Always keep them in lockstep (they must never diverge):

1. `apps/extension/package.json` - npm `version`
2. `apps/extension/public/manifest.json` - Chrome manifest `version`
3. `apps/extension/public/beta-manifest.json` - beta manifest `version`

The on-screen About page (`settings-about.tsx`) reads
`chrome.runtime.getManifest().version` **automatically** - it must never
hardcode a version string, so it follows manifest.json for free.

Other `package.json` files in the monorepo (`packages/*`, `public/*-wasm/`) are
separate library/wasm packages with their OWN versions - do NOT touch them when
bumping the app version.

## Universal bump script (USE THIS, not manual edits)

```
./scripts/bump-version.sh 25.3.0
```

It edits all three files above, prints the result, and rebuilds dist/ +
beta-dist/ with the new version baked in.

## Release flow (extension)

1. `./scripts/bump-version.sh <newversion>` - e.g. `25.3.0`.
2. Verify build + tests: `pnpm run test`, `pnpm exec tsc --noEmit`,
   `pnpm build` (script does build).
3. Load `apps/extension/dist/` unpacked in Chrome to smoke-test; confirm the
   version on the About page.
4. Commit + push. (Web-store / beta publishing is out of band.)

## Pitfalls

- Only the three files above should change for an app-version bump. If you find
  a version in a `packages/*` manifest that drifts, that's a library version,
  not the app - leave it.
- Don't ship a stale `dist/` - always rebuild after a bump.
- Never hardcode the version in UI code; read it from the manifest at runtime.
