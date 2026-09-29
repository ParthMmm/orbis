import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { apiUrl } from "@/lib/api-url";

// Only the Worker holds the address, so the page asks it once.
const getApiUrl = createServerFn({ method: "GET" }).handler(() => apiUrl());

const home = getRouteApi("/");

const Home = () => {
  const api = home.useLoaderData();
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-2 p-6">
      <h1 className="text-2xl font-medium">Orbis</h1>
      <p className="text-muted-foreground text-sm">
        Signs in to <span className="font-mono">{api}</span>
      </p>
    </main>
  );
};

export const Route = createFileRoute("/")({
  component: Home,
  loader: () => getApiUrl(),
});
