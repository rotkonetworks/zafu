# Chrome Web Store listing - zafu

Source-of-truth text for the CWS dashboard fields. Paste these when
filling out the listing. Keep this folder in sync when anything in the
dashboard changes so future re-submissions start from a reviewed copy.

## Files

- `store-listing.md` - Store listing tab (description, URLs, category, images) for beta and prod.
- `images/beta/`, `images/prod/` - icon, screenshots and promo tiles, ready to upload.
- `images/raw/` - the real screens they are built from; `tools/` regenerates both.
- `privacy-practices.md` — Privacy practices tab (single-purpose,
  data use, permission justifications).
- `privacy-policy.md` — Full privacy policy text. Host this at a
  public URL (e.g. `https://zafu.rotko.net/privacy`) and paste the URL
  into the Privacy practices tab.

## Prod vs beta

`store-listing.md` covers both listings: the descriptions differ only in the
beta notice, and the images only in the seal (beta gold, prod red).
