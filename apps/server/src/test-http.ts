import type { createApp } from "./app.js";
import type { AccessMode } from "./identity.js";

export const request = async (
  app: ReturnType<typeof createApp>,
  options: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
    host?: string;
    accessMode?: AccessMode;
  }
) => {
  const headers: Record<string, string> = {};
  const init: RequestInit = { headers, method: options.method };
  if (options.payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.payload);
  }
  Object.assign(headers, options.headers);
  const base = options.host
    ? `http://${options.host}`
    : "http://127.0.0.1:4310";
  const response = await app.handler(
    new Request(`${base}${options.url}`, init),
    options.accessMode
  );
  const body = await response.json();
  return { json: () => body, statusCode: response.status };
};
