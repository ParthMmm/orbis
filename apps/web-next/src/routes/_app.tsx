import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "@/lib/nav";
import { FAILURE_MESSAGES, fetchMe } from "@/lib/orbis";
import type { Credentials, Person } from "@/lib/orbis";
import { forgetKey, readKey } from "@/lib/stored-key";

/** The signed-in Person, and what every call from their pages carries. */
export interface Session extends Credentials {
  readonly person: Person;
}

const SessionProblem = ({ error }: ErrorComponentProps) => {
  const router = useRouter();
  // Invalidating re-runs this route's beforeLoad; resetting alone would not.
  const retry = () => router.invalidate();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <p className="text-destructive max-w-sm text-center text-sm" role="alert">
        {error instanceof Error ? error.message : FAILURE_MESSAGES.failed}
      </p>
      <Button onClick={retry} variant="outline">
        Try again
      </Button>
    </main>
  );
};

const AppShell = ({ session }: { readonly session: Session }) => {
  const navigate = useNavigate();
  const signOut = async () => {
    forgetKey();
    await navigate({ to: "/sign-in" });
  };
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center gap-6 border-b px-6 py-3">
        <Link className="font-medium" to="/">
          Orbis
        </Link>
        <nav aria-label="Main" className="flex gap-4 text-sm">
          {NAV_ITEMS.map((item) => (
            <Link
              activeProps={{ "aria-current": "page", className: "font-medium" }}
              className="text-muted-foreground"
              key={item.to}
              to={item.to}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            Signed in as {session.person.username}
          </span>
          <Button onClick={signOut} size="sm" variant="outline">
            Sign out
          </Button>
        </div>
      </header>
      <Outlet />
    </div>
  );
};

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const key = readKey();
    if (key === null) {
      throw redirect({ to: "/sign-in" });
    }
    const credentials = { apiUrl: context.apiUrl, key };
    const me = await fetchMe(credentials);
    if (me.ok) {
      const session: Session = { ...credentials, person: me.value };
      return { session };
    }
    if (me.failure === "rejected") {
      forgetKey();
      throw redirect({ search: { notice: "expired" }, to: "/sign-in" });
    }
    throw new Error(FAILURE_MESSAGES[me.failure]);
  },
  // The route hands its own context down, which keeps the context's type exact.
  component: () => <AppShell session={Route.useRouteContext().session} />,
  errorComponent: SessionProblem,
  // The key lives in the browser, so signed-in pages never render on the Worker.
  ssr: false,
});
