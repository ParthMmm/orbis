#!/bin/sh
# Writes a consistent copy of the Orbis database and trust store, then sends it off Vanta.
# ORBIS_BACKUP_DEST is an rsync destination the Host chooses, such as user@host:orbis-backups/.
set -eu
: "${ORBIS_BACKUP_DEST:?Set ORBIS_BACKUP_DEST to an rsync destination off Vanta.}"
BUN="${BUN:-$HOME/.local/share/mise/installs/bun/1.4.1/bin/bun}"
STAGING="${ORBIS_BACKUP_STAGING:-$HOME/orbis-backups}"
cd "$HOME/orbis-service/apps/server"
ORBIS_DATA_DIR="${ORBIS_DATA_DIR:-$HOME/orbis-service-data}" "$BUN" src/backup.ts "$STAGING"
# --delete keeps the destination to the same retention as the staging copy.
rsync -a --delete "$STAGING/" "$ORBIS_BACKUP_DEST"
