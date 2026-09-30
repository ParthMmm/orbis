import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";

import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // On the server, the request's CSP nonce goes on the router's inline scripts.
  const nonce = getGlobalStartContext()?.nonce;
  return createRouter({
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    routeTree,
    scrollRestoration: true,
    ssr: nonce === undefined ? {} : { nonce },
  });
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
