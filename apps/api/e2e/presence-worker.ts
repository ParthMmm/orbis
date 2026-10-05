import { hashToken } from "../../server/src/identity.js";
import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";

/** Test-only routes that read Presence storage and the Group alarm. Excluded from the production bundle. */
export class Group extends ProductionGroup {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__seed-presence") {
      await super.fetch(new Request("http://localhost/health"));
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO people (id, username, removed, social, auto_download, filters) VALUES ('player', 'player', 0, 1, 0, '[]')"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES ('player-key', ?, 'player', 'daily', 'player', ?, NULL)",
        hashToken("player-token"),
        new Date().toISOString()
      );
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, download_state, duration_seconds)
         VALUES ('presence-set', 'https://www.youtube.com/watch?v=presencexyz', 'Presence set', 'youtube', '[]', ?, 1, 'ready', 600)`,
        new Date().toISOString()
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO library_entries (person_id, set_id, saved_at, tags) VALUES ('player', 'presence-set', ?, '[]')",
        new Date().toISOString()
      );
      return new Response("seeded");
    }
    if (pathname === "/__presence") {
      await super.fetch(new Request("http://localhost/health"));
      return Response.json({
        alarm: await this.ctx.storage.getAlarm(),
        sessions: this.ctx.storage.sql
          .exec(
            "SELECT key_id, session_id, state, owner_generation, action_number, lease_expires_at, updated_at FROM presence_sessions ORDER BY session_id"
          )
          .toArray(),
      });
    }
    return super.fetch(request);
  }
}
