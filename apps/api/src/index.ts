export { Group } from "./group.js";

export interface Environment {
  readonly STREAM_GRANT_SECRET: string;
  readonly AUDIO_NODE_URL: string;
  readonly YOUTUBE_API_KEY?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly VERSOS_URL?: string;
  readonly VERSOS_API_KEY?: string;
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
