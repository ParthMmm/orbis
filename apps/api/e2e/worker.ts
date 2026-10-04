import { hashToken } from "../../server/src/identity.js";
import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";
export class Group extends ProductionGroup {
  override async fetch(request: Request): Promise<Response> {
    const ready = await super.fetch(new Request("http://group/health"));
    if (!ready.ok) {
      return ready;
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/__ready") {
      this.ctx.storage.sql.exec(
        "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = 1234"
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO people (id, username, removed, social, auto_download, filters) VALUES ('outsider', 'outsider', 0, 0, 0, '[]')"
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES ('outsider-key', ?, 'outsider', 'daily', 'outsider', ?, NULL)",
        hashToken("outsider-token"),
        new Date().toISOString()
      );
      return new Response("ready");
    }
    if (pathname === "/__seed") {
      this.ctx.storage.sql.exec(
        "INSERT INTO people (id, username, removed, social, auto_download, filters) VALUES ('host', 'host', 0, 0, 1, '[]')"
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES ('smoke-key', ?, 'smoke', 'admin', 'host', ?, NULL)",
        hashToken("smoke-token"),
        new Date().toISOString()
      );
      return new Response("seeded");
    }
    if (pathname === "/__jobs") {
      return Response.json(
        this.ctx.storage.sql
          .exec(
            "SELECT download_state AS state FROM sets INNER JOIN download_jobs ON sets.id = download_jobs.set_id"
          )
          .toArray()
      );
    }
    if (pathname === "/__schema") {
      return Response.json(
        this.ctx.storage.sql
          .exec(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
          )
          .toArray()
      );
    }
    if (pathname === "/__write") {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS smoke_state (value TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO smoke_state VALUES (?)",
        "persisted"
      );
      return new Response("saved");
    }
    if (pathname === "/__read") {
      return Response.json(
        this.ctx.storage.sql.exec("SELECT value FROM smoke_state").toArray()
      );
    }
    const response = await super.fetch(request);
    response.headers.set("x-smoke-group", this.ctx.id.toString());
    return response;
  }
}
