import type { createApp } from "./app.js";

export const request = async (
  app: ReturnType<typeof createApp>,
  options: {
    method: string;
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }
) => {
  const headers: Record<string, string> = {};
  const init: RequestInit = { headers, method: options.method };
  if (options.payload !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.payload);
  }
  Object.assign(headers, options.headers);
  const response = await app.handler(
    new Request(`http://127.0.0.1:4310${options.url}`, init)
  );
  const body = await response.json();
  return { json: () => body, statusCode: response.status };
};
