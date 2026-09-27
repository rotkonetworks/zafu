# publishing

zafu uses signed releases with verified CRX uploads to the chrome web store.

`.github/workflows/release-engine.yml` is the only build/sign/release/upload
path. It is `workflow_call`-only — nothing about a release can start by pushing
a tag.

## extension IDs

Two different IDs matter, and they are not the same number:

| variant    | store listing (dashboard)          | CWS listing | unpacked `dist/` (manifest `key`)  |
| ---------- | ---------------------------------- | ----------- | ---------------------------------- |
| production | `oojfeopgoeapfgcfhmlpfgabcbhkglck` | zafu        | `bfdfeleokgpdladfmipfmffgpjfjibbe` |
| beta       | `ppgbkpjgpggkibdojjocgndbbhiempjf` | zafu BETA   | `bhlogefpcebekhjpomlodifcelldoimn` |

- the **store listing** id is the one the dashboard shows, and the one the store
  upload is addressed by (`publishers/$PUB/items/$ITEM`). If it drifts, the
  upload 404s — re-read it from the dashboard.
- the **unpacked** id is what Chrome derives from the `key` in the manifest when
  you load `dist/`/`beta-dist/` directly, which is what local testing and
  `chrome-extension://<id>/` links in these docs refer to.

## release process

- **beta** — push to `main` (`beta.yml`; docs/CI-only pushes are skipped) or
  run it by hand. The version is the committed `manifest.json` version plus the
  run number, e.g. `28.3.1.40`, and it updates the single rolling `beta`
  release.
- **prod** — run `release.yml` by hand and type the exact committed version. It
  refuses to start unless that version matches `apps/extension/public/manifest.json`,
  then calls `release-engine.yml` with `channel: prod-only`, `release_mode: tagged`:
  build, sign, GitHub release `vX.Y.Z`, store upload.
- **pull requests** — `turbo-ci.yml` only.

## signing

### CRX signing

each build variant has its own RSA 2048 key pair, held as GitHub secrets:

- `CRX_PROD_KEY` — signs the production CRX
- `CRX_BETA_KEY` — signs the beta CRX

the engine packs the build with the manifest `key` **stripped**, then signs the
CRX with the secret, so the CRX it ships is identified by the _secret's_ key
pair. The `key` in the committed manifest only fixes the ID of an unpacked load,
so the two agree only if the secret is the private half of the manifest's public
key — worth checking when a signed CRX is meant to update a sideloaded install.

the public keys in the manifests are DER-encoded (SPKI), base64-encoded; an
unpacked id is the first 16 bytes of `sha256(der)`, each hex nibble written as
`a`–`p`.

### git tag signing

tags are signed with GPG key `E468EC955CD56FF9`. add the public key to your
github account for tags to show as "verified":

```
gpg --armor --export E468EC955CD56FF9
```

## required github secrets

| secret             | description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `CRX_PROD_KEY`     | RSA private key (PEM) for production CRX signing                 |
| `CRX_BETA_KEY`     | RSA private key (PEM) for beta CRX signing                       |
| `CWS_SA_JSON`      | Google Cloud service-account JSON key used to call the store API |
| `CWS_PUBLISHER_ID` | developer-dashboard publisher id (`publishers/$PUB/items/...`)   |

store uploads go through the Chrome Web Store API **v2**
(`chromewebstore.googleapis.com`) with a service account, so there is no OAuth
consent screen and no user refresh token (those expire after 7 days in "Testing"
status). See the
[service-account guide](https://developer.chrome.com/docs/webstore/service-accounts).

When `CWS_SA_JSON` / `CWS_PUBLISHER_ID` are unset the publish step warns and skips
— the GitHub release is still cut, only the store is left behind.

## setup checklist

- [ ] create CWS listings for both variants
- [ ] add `CRX_PROD_KEY` and `CRX_BETA_KEY` github secrets (PEM contents)
- [ ] GCP: enable "Chrome Web Store API", create a service account (no IAM roles
      needed) and a JSON key, then add the service-account email as a developer
      on both listings
- [ ] `gh secret set CWS_SA_JSON < key.json` and
      `gh secret set CWS_PUBLISHER_ID --body <dashboard publisher id>`
- [ ] add GPG public key (`E468EC955CD56FF9`) to github account
