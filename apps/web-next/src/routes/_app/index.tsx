import { createFileRoute } from "@tanstack/react-router";

const Library = () => (
  <main className="mx-auto w-full max-w-3xl p-6">
    <h1 className="text-2xl font-medium">Library</h1>
  </main>
);

export const Route = createFileRoute("/_app/")({ component: Library });
