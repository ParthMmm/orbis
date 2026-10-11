import { hashToken } from "../../server/src/identity.js";
import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";
export class Group extends ProductionGroup {
  override async fetch(request: Request): Promise<Response> {
    const ready = await super.fetch(new Request("http://group/health"));
    if (!ready.ok) {
      return ready;
    }
    if (new URL(request.url).pathname !== "/__seed") {
      return super.fetch(request);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO people (id, username, removed, social, auto_download, filters) VALUES ('host', 'host', 0, 0, 1, '[]'), ('friend', 'friend', 0, 0, 1, '[]')"
    );
    for (const [id, scope, personId] of [
      ["vanta-node", "node", "host"],
      ["friend-daily", "daily", "friend"],
    ] as const) {
      this.ctx.storage.sql.exec(
        "INSERT INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
        id,
        hashToken(`${id}-token`),
        id,
        scope,
        personId,
        now
      );
    }
    return new Response("seeded");
  }
}
