# Deployment

Zafu publishes two artefacts on every tagged release:

- a beta `.crx` for the beta extension ID `hlnodmbpndgjbhophnfbnfpgcbogiohh`
- a production `.crx` for the production extension ID
  `bfdfeleokgpdladfmipfmffgpjfjibbe`

Both are built by the `release.yml` GitHub Actions workflow on push of a
`v*` tag. Tag pushes also create a GitHub Release with the signed `.crx`
files, the source `.zip` bundles, and `sha256sums.txt` attached.

Production publication to the Chrome Web Store runs as a separate step in
the same workflow. Until the CWS app is approved, that step is expected to
fail. Pass `channel=skip` to `gh workflow run release.yml` to bypass it.

## Manual release sketch

```sh
git tag v24.X.Y
git push origin v24.X.Y
gh workflow run release.yml -f tag_name=v24.X.Y -f channel=skip
gh release view v24.X.Y
```

The workflow signs both `.crx` files with the release private key (held in
the repo's GitHub Actions secrets) and uploads them to the GitHub Release.

## Beta vs production

The two manifests differ in `name`, `version`, `key`, and the externally
connectable origin allowlist. They are otherwise identical. The build
toggle is `webpack.beta-config.ts` vs `webpack.prod-config.ts`; both pull
from the same `webpack.config.ts` base.
