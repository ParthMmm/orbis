import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import appCss from "../styles.css?url";

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
