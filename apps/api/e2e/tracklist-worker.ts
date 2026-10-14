import { hashToken } from "../../server/src/identity.js";
import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";

export class Group extends ProductionGroup {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__seed-tracklist") {
      await super.fetch(new Request("http://localhost/health"));
      const now = new Date().toISOString();
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO people (id, username, removed, social, auto_download, filters) VALUES ('listener', 'listener', 0, 1, 0, '[]')"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES ('listener-key', ?, 'listener', 'daily', 'listener', ?, NULL)",
        hashToken("listener-token"),
        now
      );
      for (const id of ["slow-set", "second-set"]) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, description, details_state)
           VALUES (?, ?, ?, 'youtube', '[]', ?, 1, '00:00 Opening track', 'filled')`,
          id,
          `https://www.youtube.com/watch?v=${id}`,
          id,
          now
        );
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO library_entries (person_id, set_id, saved_at, tags) VALUES ('listener', ?, ?, '[]')",
          id,
          now
        );
      }
      return new Response("seeded");
    }
    if (pathname === "/__seed-library") {
      const now = new Date().toISOString();
      for (let index = 0; index < 40; index += 1) {
        const id = `library-set-${index}`;
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, details_state, download_state)
           VALUES (?, ?, ?, 'youtube', '[]', ?, 1, 'filled', 'ready')`,
          id,
          `https://www.youtube.com/watch?v=${id}`,
          id,
          now
        );
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO library_entries (person_id, set_id, saved_at, tags) VALUES ('listener', ?, ?, '[]')",
          id,
          now
        );
      }
      return new Response("seeded");
    }
    return super.fetch(request);
  }
}
