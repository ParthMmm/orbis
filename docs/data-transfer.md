# Transfer and restore Group data

Run these commands from the repository root with Bun 1.4.1. The SQL format includes every application table, trust key digest, row order, SQLite sequence, and Drizzle migration record. The manifest comment and SQL must agree. Table checksums cover the ordered columns and typed rows with SHA-256.

## Historical cutover import

These steps record the one-time migration from the retired Bun API to an empty Group. Do not use them for a current backup or restore. The retired API applied migrations and imported legacy `devices.json` data before this sequence began.

1. Put the retired API into read-only mode, stop it, and export its database.

```sh
bun scripts/data-transfer.ts export /path/to/library.sqlite /private/group.sql
```

2. Set `ORBIS_NODE_KEY` to that token in your shell. Set the temporary Worker secret `IMPORT_NODE_KEY_DIGEST` to its SHA-256 digest. Use the same node key that the SQL export holds. Do not mint a separate key in the empty Group.
3. Import into the Group.

```sh
bun scripts/data-transfer.ts import /private/group.sql https://orbis.p11a.xyz/api
```

The script compares the Group's count and checksum for each table with the source. It prints success only when every table matches. The Group refuses a second import with `409`. A failed schema check, constraint, foreign key check, or missing importing key rolls back all changes.

4. Remove `IMPORT_NODE_KEY_DIGEST` after the import. The Group already ignores it after successful import or while application data exists. The imported node key authenticates subsequent exports.

## Export and restore

`GET /api/export` requires a node key and returns SQL. A daily or admin key cannot call either transfer route. A node key cannot call a client route.

Set `ORBIS_NODE_KEY` to the Group's node key before you create a backup. The script sends it as a Bearer key to `/api/export`.

```sh
bun scripts/data-transfer.ts backup https://orbis.p11a.xyz/api /private/backups
bun scripts/data-transfer.ts restore /private/backups/chosen.sql /private/restore/library.sqlite
```

Backup retains the newest 14 SQL files. Restore creates a private SQLite copy and refuses to overwrite an existing destination. It exports that copy and compares the result with the source SQL before it publishes the file. The SQL includes the trust tables, so a current backup has no separate `devices.json` file.

Keep the restored database as an offline recovery artifact. The production audio node has no database, and the repository has no local API command that serves this file. Use the verification driver below to test a restored copy through the shared HTTP application.

## Verify a copy of real data

Build the contracts, then run the verification driver with the source data directory:

```sh
bun run --cwd packages/contracts build
bun apps/api/e2e/transfer-verify.ts /home/parth/Developer/orbis-service-data
```

The driver opens the source SQLite database read-only and uses `VACUUM INTO` to take a consistent private snapshot. It copies legacy trust data, migrates only the copy, and mints scratch node and Host keys in the private copy. It imports into a local workerd Group, compares every table, exports the Group, and restores the export to another private SQLite file. A test-only `createPortableApp` instance then compares the Host's HTTP Library, Playlists, Queue, positions, titles, and Tracklists across the source copy, the Group, and the restored copy. The driver also checks a private fixture with a nonempty ordered Playlist, named Cues, edited Unicode titles, and a constraint failure during import.

The final path points to a JSON report with counts, checksums, and HTTP routes checked. It does not include key tokens, digests, or data rows. SQL and database files remain inside directories with mode `0700`; SQL files use `0600`.

Cloudflare does not support `PRAGMA user_version`. The Group stores that value through its synchronous KV API in the import transaction and restores it in exports. The export excludes Cloudflare's reserved KV table. [Cloudflare SQLite storage reference](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
