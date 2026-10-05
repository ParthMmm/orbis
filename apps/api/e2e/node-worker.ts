import { hashToken } from "../../server/src/identity.js";
import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";
export class Group extends ProductionGroup {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__seed-node") {
      await super.fetch(new Request("http://localhost/health"));
      for (const [id, scope] of [
        ["client", "daily"],
        ["peer", "daily"],
        ["node", "node"],
      ]) {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO people (id, username, removed, auto_download) VALUES (?, ?, 0, 1)",
          id,
          id
        );
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO api_keys (id, digest, label, scope, person_id, added_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          hashToken(`${id}-token`),
          id,
          scope,
          id,
          new Date().toISOString()
        );
      }
      return new Response("seeded");
    }
    if (pathname === "/__node-set") {
      return Response.json(
        this.ctx.storage.sql
          .exec(
            "SELECT details_state, source_tags FROM sets WHERE id = ?",
            new URL(request.url).searchParams.get("id")
          )
          .toArray()[0]
      );
    }
    if (pathname === "/__node-jobs") {
      return Response.json(
        this.ctx.storage.sql.exec("SELECT * FROM download_jobs").toArray()
      );
    }
    return super.fetch(request);
  }
}
