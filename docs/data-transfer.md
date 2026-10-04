# Transfer and restore Group data

Run these commands from the repository root with Bun 1.4.1. The SQL format includes every application table, trust key digest, row order, SQLite sequence, and Drizzle migration record. The manifest comment and SQL must agree. Table checksums cover the ordered columns and typed rows with SHA-256.

## Import into an empty Group

1. Migrate the source database with the current server. Import the legacy `devices.json` into SQLite through the trust CLI if it has not moved yet.
2. Mint a node key in the source database. Keep the printed token private. Export after minting the key.

```sh
bun apps/server/src/trust.ts key add --person host --label audio-node --scope node --database /path/to/library.sqlite
bun scripts/data-transfer.ts export /path/to/library.sqlite /private/group.sql
```

3. Set `ORBIS_NODE_KEY` to that token in your shell. Set the temporary Worker secret `IMPORT_NODE_KEY_DIGEST` to its SHA-256 digest. Use the same node key that the SQL export holds. Do not mint a separate key in the empty Group.
4. Enter the read-only window before the final export. Import into the Group.

```sh
bun scripts/data-transfer.ts import /private/group.sql https://orbis.p11a.xyz/api
```

The script compares the Group's count and checksum for each table with the source. It prints success only when every table matches. The Group refuses a second import with `409`. A failed schema check, constraint, foreign key check, or missing importing key rolls back all changes.

5. Remove `IMPORT_NODE_KEY_DIGEST` after the import. The Group already ignores it after successful import or while application data exists. The imported node key authenticates subsequent exports.

## Export and restore

`GET /api/export` requires a node key and returns SQL. A daily or admin key cannot call either transfer route. A node key cannot call a client route.

```sh
bun scripts/data-transfer.ts backup https://orbis.p11a.xyz/api /private/backups
bun scripts/data-transfer.ts restore /private/backups/chosen.sql /private/restore/library.sqlite
```

Backup retains the newest 14 SQL files. Restore creates a new database and refuses to overwrite an existing destination. It compares the restored SQL with the export before publishing the file. Trust remains in SQLite, so `devices.json` is not part of a new backup. Start the Bun API against the scratch restore before replacing the service's data.

## Verify a copy of real data

Build the contracts, then run the verification driver with the source data directory:

```sh
bun run --cwd packages/contracts build
bun apps/api/e2e/transfer-verify.ts /home/parth/Developer/orbis-service-data
```

The driver opens the source SQLite database read-only and uses `VACUUM INTO` to take a consistent private snapshot. It copies legacy trust data, migrates only the copy, and mints scratch node and Host keys with the CLI. It imports into a local workerd Group, compares every table, exports, restores to Bun, and compares the Host's HTTP Library, Playlists, Queue, positions, titles, and Tracklists. It also checks a private fixture with a nonempty ordered Playlist, named Cues, edited Unicode titles, and a constraint failure during import.

The final path points to a JSON report with counts, checksums, and HTTP routes checked. It does not include key tokens, digests, or data rows. SQL and database files remain inside directories with mode `0700`; SQL files use `0600`.

Cloudflare does not support `PRAGMA user_version`. The Group stores that value through its synchronous KV API in the import transaction and restores it in exports. The export excludes Cloudflare's reserved KV table. [Cloudflare SQLite storage reference](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
