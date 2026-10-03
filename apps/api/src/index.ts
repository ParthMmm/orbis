export { Group } from "./group.js";

export interface Environment {
  readonly GROUP: DurableObjectNamespace;
}

export default {
  fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }
    url.pathname = url.pathname.slice(4);
    return env.GROUP.getByName("group").fetch(new Request(url, request));
  },
};
