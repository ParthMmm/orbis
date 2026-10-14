#!/bin/sh
set -eu
: "${ORBIS_BACKUP_DEST:?Set ORBIS_BACKUP_DEST to an rsync destination.}"
BUN="${BUN:-$HOME/.local/share/mise/installs/bun/1.4.1/bin/bun}"
STAGING="${ORBIS_BACKUP_STAGING:-$HOME/orbis-backups}"
cd "$(dirname "$0")/../.."
KIND=group
: "${ORBIS_GROUP_API_URL:?Set ORBIS_GROUP_API_URL to the Group API address.}"
"$BUN" scripts/data-transfer.ts backup "$ORBIS_GROUP_API_URL" "$STAGING/$KIND"
rsync -a --delete "$STAGING/$KIND/" "${ORBIS_BACKUP_DEST%/}/$KIND/"
