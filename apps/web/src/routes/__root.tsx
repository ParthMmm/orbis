import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { apiUrl } from "@/lib/api-url";

import appCss from "../styles.css?url";

// Only the Worker holds the API address, so the page asks it once per load.
const getApiUrl = createServerFn({ method: "GET" }).handler(() => apiUrl());
let knownApiUrl: string | undefined;
const loadApiUrl = async (): Promise<string> => {
  knownApiUrl ??= await getApiUrl();
  return knownApiUrl;
};

const RootDocument = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

export const Route = createRootRoute({
  beforeLoad: async () => ({ apiUrl: await loadApiUrl() }),
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "Orbis" },
    ],
  }),
  notFoundComponent: () => (
    <main className="mx-auto max-w-md p-6 pt-16">
      <h1 className="font-medium">Page not found</h1>
    </main>
  ),
  shellComponent: RootDocument,
});
