#!/usr/bin/env bash
set -euo pipefail

# Export a clean, gitignore-safe source tarball for off-box review or upload.
# Respects .gitignore: node_modules, dist, pamela-publish-data, env, logs,
# .vite, and the .bak-146 fingerprint backup are EXCLUDED.
# Does not require git history. Does not include production data or secrets.

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT="${OUT:-/root/export}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

rm -rf "$OUT"
mkdir -p "$OUT"

# Temporary filter file built from .gitignore unchanged-pattern lines.
FILTER="$OUT/.filter"
{
  echo 'node_modules/'
  echo 'dist/'
  echo 'pamela-publish-data/'
  echo '.git/'
  echo '*.log'
  echo '.env'
  echo '.env.*'
  echo '.vite/'
  echo '.DS_Store'
  echo 'src/data/*.bak-146'
} > "$FILTER"

EXCLUDE_args=()
while IFS= read -r pat; do
  [[ -z "$pat" || "$pat" == \#* ]] && continue
  EXCLUDE_args+=(--exclude="$pat")
done < "$FILTER"

tar --exclude-backups -C "$SRC" \
  ${EXCLUDE_args[@]} \
  --owner=0 --group=0 --numeric-owner \
  -czf "$OUT/model-verity-open-source.tar.gz" \
  AGENTS.md README.md LICENSE SECURITY.md 第三方声明.md package.json package-lock.json \
  tsconfig.json tsconfig.node.json tsup.config.ts .gitignore .gitattributes \
  src scripts test docs

echo "exported: $OUT/model-verity-open-source.tar.gz"
echo "listed files:"; tar -tzf "$OUT/model-verity-open-source.tar.gz" | sed 's#^#  #' | head -80
echo "archive excludes node_modules/dist/pamela-publish-data/env/logs/bak. verify above."