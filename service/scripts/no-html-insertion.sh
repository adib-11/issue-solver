#!/usr/bin/env bash
# Fails if UI source uses any API that parses a string as HTML. Issue text must render only as text.
set -euo pipefail
cd "$(dirname "$0")/../src/ui"
pattern='innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|parseFromString|setHTMLUnsafe|srcdoc|dangerouslySetInnerHTML'
if grep -rnE "$pattern" --include='*.ts' --include='*.tsx' --include='*.js' .; then
  echo "UI source must not use HTML-insertion APIs (see matches above)." >&2
  exit 1
fi
