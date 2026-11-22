# releasing zafu

Two release lanes, one rule: **CI builds, verifies and publishes, but never
alone signs anything that can reach a user's seed.**

| lane         | what                                                      | signed by                        |
| ------------ | --------------------------------------------------------- | -------------------------------- |
| extension    | the Chrome extension (CRX)                                | CI-held CRX keys (prod, beta)    |
| firmware OTA | zigner protocol modules (they receive the seed on-device) | 2-of-3 FROST; CI holds one share |

A bad extension is recoverable (uninstall, push a fix). A bad zigner module is
not: it runs with the mnemonic and its output crosses the air gap, so its
signature must never be something CI can produce alone.

## extension

`.github/workflows/release-engine.yml` is the only build, sign and release
path. It is `workflow_call` only; nothing releases on a tag push.

### beta: follows main

Every push to `main` (docs- and CI-only pushes are skipped) runs `beta.yml`.
The version is the committed beta manifest version plus the run number, e.g.
`29.7.1.188`, so the store never sees a duplicate, and the rolling `beta`
GitHub prerelease is updated in place. It can also be run by hand.

### prod: by hand

1. Bump the three version files with `./scripts/bump-version.sh X.Y.Z`
   (`apps/extension/package.json`, `public/manifest.json`,
   `public/beta-manifest.json`; see AGENTS.md).
2. Add a `## X.Y.Z` section to the root `CHANGELOG.md`. CI
   (`consistency.yml`) fails without it.
3. Merge to `main`, then run **Actions › Release (prod, manual)** and type the
   version (`vX.Y.Z`). It refuses unless that matches
   `apps/extension/public/manifest.json`, then builds, signs and cuts the
   tagged GitHub release. `dry_run: true` builds and signs without releasing.

### the Chrome Web Store: by hand

CI does not upload to the store: the service account is refused by both
listings, so the step only prints a reminder. Upload the
`zafu-<channel>-<version>.zip` from the GitHub release to the item below in
the developer dashboard. Never upload a zip of a local `dist/`: it carries the
manifest `key`.

| variant | store item (dashboard, upload)     | unpacked id (manifest `key`)       |
| ------- | ---------------------------------- | ---------------------------------- |
| prod    | `oojfeopgoeapfgcfhmlpfgabcbhkglck` | `bfdfeleokgpdladfmipfmffgpjfjibbe` |
| beta    | `ppgbkpjgpggkibdojjocgndbbhiempjf` | `bhlogefpcebekhjpomlodifcelldoimn` |

The store item id is what the dashboard shows. The unpacked id is what Chrome
derives from the manifest `key` when you load `dist/` or `beta-dist/`
directly.

### signing

Each variant has its own RSA key, held as a GitHub secret: `CRX_PROD_KEY`
and `CRX_BETA_KEY` (PEM). The engine packs the build with the manifest `key`
stripped and signs with the secret, so the CRX is identified by the secret's
key pair; it matches the unpacked id only if the secret is the private half
of the manifest's public key.

Tags are signed with GPG key `E468EC955CD56FF9`
(`gpg --armor --export E468EC955CD56FF9` to add it to a GitHub account).

The store-upload secrets (`CWS_SA_JSON`, `CWS_PUBLISHER_ID`) stay defined for
when the service account is granted access again; the disabled step in
`release-engine.yml` shows the call.

## firmware OTA (2-of-3 FROST)

Zigner protocol modules are signed by a 2-of-3 FROST group; no party holds
two shares.

- **CI:** one share, used only to complete a signature a person started.
- **release manager:** one share, presigns offline.
- **cold backup:** one share, offline, for recovery.

1. The build produces the module manifest (module bytes, version, trust
   anchors), deterministically, and it is committed for review.
2. The release manager reviews it and presigns their share offline, bound to
   those exact bytes.
3. On an `ota-*` tag, `ota-release.yml` adds CI's share, aggregates the
   signature and publishes the signed module.
4. Zigner and zafu verify it against the pinned group key.

A CI compromise leaks one share, which is useless without the release
manager's presign. The specs are in `apps/extension/src/ota/spec/`.
