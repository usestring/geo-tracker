#!/usr/bin/env bash
# Daily DB snapshot -> a GitHub release on a PRIVATE repo.
#
# Why releases: the code repo stays code-only (data/ is gitignored, and daily
# multi-MB blobs would balloon git history), so the backup needs somewhere else
# to live and this needs no new credentials beyond the gh CLI.
#
# Why a SEPARATE private repo: release assets inherit repo visibility. If this
# tracker's repo is public, pointing backups at it publishes your database -
# the full question bank, every raw engine answer, and the citation ledger.
# Set BACKUP_REPO to a private repo you own. Unset, this script does nothing.
#
# Each snapshot is its own release tagged db-backup-YYYYMMDD; pruning deletes
# whole releases beyond the newest KEEP. Re-running on the same day is a no-op.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${BACKUP_REPO:-}"
KEEP="${BACKUP_KEEP:-14}"

if [ -z "$REPO" ]; then
  echo "backup: BACKUP_REPO not set - skipping. See README (Backups)."
  exit 0
fi
STAMP=$(date +%Y%m%d)
TAG="db-backup-${STAMP}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "backup: $TAG already exists - nothing to do"
  exit 0
fi

# VACUUM INTO takes a consistent snapshot even if a run is mid-write.
sqlite3 data/geo.db "VACUUM INTO '$TMP/geo.db'"
gzip -9 "$TMP/geo.db"
mv "$TMP/geo.db.gz" "$TMP/geo-${STAMP}.db.gz"

gh release create "$TAG" "$TMP/geo-${STAMP}.db.gz" --repo "$REPO" \
  --title "DB backup ${STAMP}" \
  --notes "Snapshot of data/geo.db (gzipped). Restore: gunzip, replace data/geo.db." >/dev/null
echo "backup: created $TAG"

# Prune whole releases beyond the newest $KEEP. If org policy ever blocks
# deleting immutable releases, this prints the failure and the backup itself
# still succeeded - growth is ~15MB/day, so there is time to react.
gh release list --repo "$REPO" --json tagName -q '.[].tagName' |
  grep -E '^db-backup-[0-9]{8}$' | sort -r | tail -n "+$((KEEP + 1))" |
  while read -r old; do
    if gh release delete "$old" --repo "$REPO" --cleanup-tag --yes >/dev/null 2>&1; then
      echo "backup: pruned $old"
    else
      echo "backup: WARNING could not prune $old (immutable-release policy?)"
    fi
  done
