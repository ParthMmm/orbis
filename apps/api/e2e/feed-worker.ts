import { hashToken } from "../../server/src/identity.js";
import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";

const PEOPLE = ["ana", "ben"];
const KEYS = [
  ["ana-phone", "ana", "daily"],
  ["ana-laptop", "ana", "daily"],
  ["ana-tablet", "ana", "daily"],
  ["ben-phone", "ben", "daily"],
  ["host-admin", "host", "admin"],
  ["vanta-node", "host", "node"],
] as const;

export class Group extends ProductionGroup {
  constructor(
    ctx: DurableObjectState,
    env: ConstructorParameters<typeof ProductionGroup>[1]
  ) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS journey_constructions (at INTEGER NOT NULL)"
    );
    ctx.storage.sql.exec(
      "INSERT INTO journey_constructions (at) VALUES (?)",
      Date.now()
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__seed-feed") {
      await super.fetch(new Request("http://localhost/health"));
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO people (id, username, removed, social, auto_download, filters) VALUES ('host', 'host', 0, 0, 0, '[]')"
      );
      for (const id of PEOPLE) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO people (id, username, removed, social, auto_download, filters) VALUES (?, ?, 0, 1, 1, '[]')",
          id,
          id
        );
      }
      for (const [id, personId, scope] of KEYS) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
          id,
          hashToken(`token-${id}`),
          id,
          scope,
          personId,
          now
        );
      }
      for (const id of ["set-1", "set-2"]) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, download_state, duration_seconds)
           VALUES (?, ?, ?, 'youtube', '[]', ?, 1, 'ready', 600)`,
          id,
          `https://www.youtube.com/watch?v=${id.replace("-", "")}feedxx`,
          `Feed ${id}`,
          now
        );
        for (const personId of PEOPLE) {
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO library_entries (person_id, set_id, saved_at, tags) VALUES (?, ?, ?, '[]')",
            personId,
            id,
            now
          );
        }
      }
      return new Response("seeded");
    }
    if (pathname === "/__feed-state") {
      await super.fetch(new Request("http://localhost/health"));
      return Response.json({
        attachments: this.ctx
          .getWebSockets("feed")
          .map((socket) => socket.deserializeAttachment()),
        connections: this.ctx.storage.sql
          .exec(
            "SELECT id, key_id, person_id, greeted, json_array_length(unacked_sequences) AS unacknowledged, acked_cursor IS NOT NULL AS acked FROM feed_connections ORDER BY opened_at"
          )
          .toArray(),
        constructions: this.ctx.storage.sql
          .exec("SELECT at FROM journey_constructions ORDER BY at")
          .toArray()
          .map((row) => row.at),
        nodeSockets: this.ctx.getWebSockets("node").length,
        tickets: this.ctx.storage.sql
          .exec("SELECT COUNT(*) AS count FROM feed_tickets")
          .one().count,
      });
    }
    return super.fetch(request);
  }
}
