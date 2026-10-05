import {
  configureLogging,
  finishRequestLog,
  startRequestLog,
} from "../../server/src/logging.js";
import { accessDenied, authorizedRecovery } from "./access.js";
import type { AccessConfiguration } from "./access.js";

export { Group } from "./group.js";

export interface Environment extends AccessConfiguration {
  readonly STREAM_GRANT_SECRET: string;
  readonly AUDIO_NODE_URL: string;
  readonly YOUTUBE_API_KEY?: string;
  readonly OPENROUTER_API_KEY?: string;
  readonly VERSOS_URL?: string;
  readonly VERSOS_API_KEY?: string;
  readonly IMPORT_NODE_KEY_DIGEST?: string;
  readonly GROUP: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/api/recovery") {
      const logging = { pretty: false, silent: false };
      configureLogging(logging);
      const logger = startRequestLog({
        method: request.method,
        path: "/api/recovery",
        requestId: crypto.randomUUID(),
      });
      url.pathname = "/recovery";
      const response = (await authorizedRecovery(request, env))
        ? await env.GROUP.getByName("group").fetch(new Request(url, request))
        : accessDenied();
      finishRequestLog(
        logger,
        {
          outcome: response.status < 400 ? "success" : "rejected",
          status: response.status,
        },
        logging
      );
      return response;
    }
    url.pathname = url.pathname.slice(4);
    return env.GROUP.getByName("group").fetch(new Request(url, request));
  },
};
