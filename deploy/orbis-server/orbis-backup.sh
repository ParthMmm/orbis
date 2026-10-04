#!/bin/sh
# Writes a backup, then syncs it to ORBIS_BACKUP_DEST.
# ORBIS_BACKUP_DEST is an rsync destination the Host chooses: a path on another disk, or user@host:orbis-backups/.
set -eu
: "${ORBIS_BACKUP_DEST:?Set ORBIS_BACKUP_DEST to an rsync destination.}"
BUN="${BUN:-$HOME/.local/share/mise/installs/bun/1.4.1/bin/bun}"
STAGING="${ORBIS_BACKUP_STAGING:-$HOME/orbis-backups}"
# Run from the checkout that holds this script, wherever it lives.
cd "$(dirname "$0")/../.."
if [ -n "${ORBIS_GROUP_API_URL:-}" ]; then
  KIND=group
  "$BUN" scripts/data-transfer.ts backup "$ORBIS_GROUP_API_URL" "$STAGING/$KIND"
else
  KIND=sqlite
  ORBIS_DATA_DIR="${ORBIS_DATA_DIR:-$HOME/Developer/orbis-service-data}" "$BUN" apps/server/src/backup.ts "$STAGING/$KIND"
fi
rsync -a --delete "$STAGING/$KIND/" "${ORBIS_BACKUP_DEST%/}/$KIND/"
