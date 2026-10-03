import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";
export class Group extends ProductionGroup {
  override async fetch(request: Request): Promise<Response> {
    const ready = await super.fetch(new Request("http://group/health"));
    if (!ready.ok) {
      return ready;
    }
    const { pathname } = new URL(request.url);
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
