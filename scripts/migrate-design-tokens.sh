#!/usr/bin/env bash
# Mechanical swap from legacy shadcn-style tokens to the v2 design system.
#
# Legacy tokens still work because globals.css keeps them as aliases — this
# script just swaps the class NAMES so future palette edits propagate from
# globals.css and the code matches the design spec in
# packages/ui/docs/design-preview/.
#
# Usage:
#   scripts/migrate-design-tokens.sh <path>...
#   scripts/migrate-design-tokens.sh apps/extension/src/routes/popup/home
#
# Run git diff after, eyeball for surprises (the cases that need a design
# decision — is this a kicker? should this figure be zigner-gold? — can't be
# mechanically migrated and should be done by hand).
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <path>..." >&2
  exit 1
fi

# Order matters: longer / more-specific patterns first, so the literal /40
# and /50 alpha suffixes don't survive and get matched by later rules.
# Mapping reference:
#   border-soft  = --surface-border-soft  #1a1a1a  (row hairlines)
#   border-hard  = --surface-border       #212121  (card / input edge)
#   elev-1       = --surface-elev-1       #0a0a0a  (cards, code, popovers)
#   elev-2       = --surface-elev-2       #0f0f0f  (inputs, deeper surfaces)
#   fg-high      = --fg-high              #f5f5f5  (strongest ink)
#   fg           = --fg                   #dcdcdc  (body)
#   fg-muted     = --fg-muted             #8a8a8a  (secondary)
#   fg-dim       = --fg-dim               #5a5a5a  (timestamps, labels)
#   zigner-gold  = #f4b728                         (brand accent · "figure")
SUBS=(
  # hover states (must come before their non-hover forms)
  's/\bhover:bg-muted\/50\b/hover:bg-elev-1/g'
  's/\bhover:bg-muted\/30\b/hover:bg-elev-1/g'
  's/\bhover:bg-muted(?![-\w])/hover:bg-elev-1/g'
  's/\bhover:bg-accent(?![-\w])/hover:bg-elev-1/g'
  's/\bhover:text-foreground(?![-\w])/hover:text-fg-high/g'
  's/\bhover:text-primary(?![-\w])/hover:text-zigner-gold/g'
  's/\bhover:text-muted-foreground(?![-\w])/hover:text-fg-muted/g'

  # *-muted-foreground family — MUST come before bare *-muted rules below
  # so `bg-muted-foreground/30` doesn't get mangled into `bg-elev-2-foreground/30`.
  's/\b(bg|text|border|ring|divide|from|to|via|fill|stroke|shadow)-muted-foreground(?![-\w])/$1-fg-muted/g'
  's/\btext-muted-foreground\/60\b/text-fg-dim/g'
  's/\btext-muted-foreground\/80\b/text-fg-muted/g'

  # surfaces (muted background family). Negative lookahead so we don't touch
  # a migrated token like `bg-muted-foreground` (already covered above) and
  # so `bg-muted-radial` / `bg-muted-whatever-custom` aren't double-mutated.
  's/\bbg-muted\/50\b/bg-elev-2/g'
  's/\bbg-muted\/30\b/bg-elev-2/g'
  's/\bbg-muted(?![-\w])/bg-elev-2/g'

  # borders — alpha forms collapse to the dedicated soft hairline token.
  # IMPORTANT: the bare `border-border` rule uses a negative lookahead so it
  # does NOT match inside `border-border-soft` / `border-border-hard` (the v2
  # replacements). Without that, re-running the script would double-mutate
  # a migrated file into `border-border-hard-soft`.
  's/\bborder-border\/40\b/border-border-soft/g'
  's/\bborder-border\/60\b/border-border-soft/g'
  's/\bborder-border\/30\b/border-border-soft/g'
  's/\bborder-border(?![-\w])/border-border-hard/g'

  # canvas / foreground (keep /N alpha forms intact via HSL aliases)
  's/\bbg-background\b(?!\/)/bg-canvas/g'
  's/\btext-foreground\b(?!\/)/text-fg/g'
  's/\bbg-foreground\b(?!\/)/bg-fg/g'

  # shadcn card / popover surfaces collapse onto elev-1. Negative lookahead
  # `(?![-\w])` prevents mauling custom siblings like `bg-card-radial` (a
  # radial-gradient utility defined in tailwind-config).
  's/\btext-card-foreground(?![-\w])/text-fg/g'
  's/\bbg-card(?![-\w\/])/bg-elev-1/g'
  's/\btext-popover-foreground(?![-\w])/text-fg/g'
  's/\bbg-popover(?![-\w\/])/bg-elev-1/g'

  # accent (was a gold-tinted dark) → elev-1 (system prefers hairline greys)
  's/\btext-accent-foreground(?![-\w])/text-fg-high/g'
  's/\bbg-accent(?![-\w\/])/bg-elev-1/g'

  # primary = zigner-gold
  's/\btext-primary-foreground(?![-\w])/text-zigner-dark/g'
  's/\btext-primary(?![-\w])/text-zigner-gold/g'
  's/\bbg-primary(?![-\w\/])/bg-zigner-gold/g'
  's/\bborder-primary(?![-\w\/])/border-zigner-gold/g'
)

# collect files
files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(find "$@" -type f \( -name '*.tsx' -o -name '*.ts' \) -print0)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "no .tsx / .ts files under $*" >&2
  exit 1
fi

echo "migrating ${#files[@]} files…"
for f in "${files[@]}"; do
  before=$(md5sum "$f" | awk '{print $1}')
  for s in "${SUBS[@]}"; do
    # -E for extended regex + -i in place. macOS sed differs — if on darwin,
    # run `brew install gnu-sed` and swap `sed` for `gsed`.
    perl -i -pe "$s" "$f"
  done
  after=$(md5sum "$f" | awk '{print $1}')
  [[ "$before" != "$after" ]] && echo "  touched: $f"
done

echo "done. run git diff to review."
