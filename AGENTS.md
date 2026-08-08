# AGENTS.md — Zafu (rotkonetworks/zafu) — versioning & release

Source of truth for how to bump versions and ship the Zafu browser extension.

## Zafu's version is the Chrome extension version: 25.x.y

It's a browser extension (not a mobile app). The user-facing release number is
the Chrome manifest `version`.

## The app version is mirrored in exactly THREE source files

Always keep them in lockstep (they must never diverge):

1. `apps/extension/package.json`         — npm `version`
2. `apps/extension/public/manifest.json` — Chrome manifest `version`
3. `apps/extension/public/beta-manifest.json` — beta manifest `version`

The on-screen About page (`settings-about.tsx`) reads
`chrome.runtime.getManifest().version` **automatically** — it must never
hardcode a version string, so it follows manifest.json for free.

Other `package.json` files in the monorepo (`packages/*`, `public/*-wasm/`) are
separate library/wasm packages with their OWN versions — do NOT touch them when
bumping the app version.

## Universal bump script (USE THIS, not manual edits)

```
./scripts/bump-version.sh 25.3.0
```

It edits all three files above, prints the result, and rebuilds dist/ +
beta-dist/ with the new version baked in.

## Release flow (extension)

1. `./scripts/bump-version.sh <newversion>` — e.g. `25.3.0`.
2. Verify build + tests: `pnpm run test`, `pnpm exec tsc --noEmit`,
   `pnpm build` (script does build).
3. Load `apps/extension/dist/` unpacked in Chrome to smoke-test; confirm the
   version on the About page.
4. Commit + push. (Web-store / beta publishing is out of band.)

## Pitfalls

- Only the three files above should change for an app-version bump. If you find
  a version in a `packages/*` manifest that drifts, that's a library version,
  not the app — leave it.
- Don't ship a stale `dist/` — always rebuild after a bump.
- Never hardcode the version in UI code; read it from the manifest at runtime.
