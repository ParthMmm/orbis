#!/bin/sh
# Writes a consistent copy of the Orbis database and trust store, then syncs it to ORBIS_BACKUP_DEST.
# ORBIS_BACKUP_DEST is an rsync destination the Host chooses: a path on another disk, or user@host:orbis-backups/.
set -eu
: "${ORBIS_BACKUP_DEST:?Set ORBIS_BACKUP_DEST to an rsync destination.}"
BUN="${BUN:-$HOME/.local/share/mise/installs/bun/1.4.1/bin/bun}"
STAGING="${ORBIS_BACKUP_STAGING:-$HOME/orbis-backups}"
# Run from the checkout that holds this script, wherever it lives.
cd "$(dirname "$0")/../../apps/server"
ORBIS_DATA_DIR="${ORBIS_DATA_DIR:-$HOME/orbis-service-data}" "$BUN" src/backup.ts "$STAGING"
# --delete keeps the destination to the same retention as the staging copy.
rsync -a --delete "$STAGING/" "$ORBIS_BACKUP_DEST"
