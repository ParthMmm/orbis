import { createMiddleware, createStart } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";

import { apiUrl } from "@/lib/api-url";

const securityHeaders = createMiddleware().server(({ next }) => {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const api = new URL(apiUrl()).origin;
  const audio = new URL(process.env.ORBIS_AUDIO_URL ?? api).origin;
  setResponseHeaders(
    new Headers({
      "Content-Security-Policy": [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https: data:",
        "font-src 'self'",
        `connect-src 'self' ${api}`,
        `media-src ${api} ${audio}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
    })
  );
  return next({ context: { nonce } });
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders],
}));
