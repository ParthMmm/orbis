import { Group as ProductionGroup } from "../src/group.js";
import worker from "../src/index.js";
import type { Environment } from "../src/index.js";

export class Group extends ProductionGroup {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    response.headers.set("x-recovery-group", "reached");
    return response;
  }
}
export default {
  fetch(request: Request, env: Environment) {
    if (new URL(request.url).pathname === "/direct-group") {
      return env.GROUP.getByName("group").fetch(
        new Request("https://group/recovery", request)
      );
    }
    return worker.fetch(request, env);
  },
};
