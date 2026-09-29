import {
  createFileRoute,
  getRouteApi,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { orbis } from "@/lib/orbis";
import type { ApiFailure } from "@/lib/orbis";
import { forgetKey, readKey, storeKey } from "@/lib/stored-key";

export type Person = Extract<
  Awaited<ReturnType<ReturnType<typeof orbis>["me"]>>,
  { ok: true }
>["value"];

export interface Session {
  readonly apiUrl: string;
  readonly person: Person | null;
  readonly problem: string | null;
}

const PROBLEMS: Readonly<Record<ApiFailure, string>> = {
  failed: "Orbis could not complete the request. Try again.",
  rejected: "That API key does not work.",
  // No response at all; on a tailnet device this is often Chrome blocking the
  // call until the Person allows local network access.
  unreachable:
    "Orbis could not be reached. If your browser asks to access devices on your local network, allow it and try again.",
};

const loadSession = async (apiUrl: string): Promise<Session> => {
  const key = readKey();
  if (key === null) {
    return { apiUrl, person: null, problem: null };
  }
  const me = await orbis(apiUrl, key).me();
  if (me.ok) {
    return { apiUrl, person: me.value, problem: null };
  }
  if (me.failure === "rejected") {
    forgetKey();
    return {
      apiUrl,
      person: null,
      problem: "Your saved key no longer works. Paste a new one.",
    };
  }
  return { apiUrl, person: null, problem: PROBLEMS[me.failure] };
};

const home = getRouteApi("/");

const SignIn = ({ session }: { readonly session: Session }) => {
  const router = useRouter();
  const [problem, setProblem] = useState(session.problem);
  const [pending, setPending] = useState(false);
  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = String(
      new FormData(event.currentTarget).get("key") ?? ""
    ).trim();
    if (key === "") {
      setProblem("Paste the API key from your Host.");
      return;
    }
    setPending(true);
    const me = await orbis(session.apiUrl, key).me();
    if (!me.ok) {
      setProblem(PROBLEMS[me.failure]);
      setPending(false);
      return;
    }
    storeKey(key);
    await router.invalidate();
  };
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1>Sign in to Orbis</h1>
        </CardTitle>
        <CardDescription>Paste the API key your Host sent you.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={signIn}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key">API key</Label>
            <Input
              autoComplete="off"
              id="api-key"
              name="key"
              spellCheck={false}
              type="password"
            />
          </div>
          {problem === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          )}
          <Button disabled={pending} type="submit">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

const SignedIn = ({ person }: { readonly person: Person }) => {
  const router = useRouter();
  const signOut = async () => {
    forgetKey();
    await router.invalidate();
  };
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1>Signed in as {person.username}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Button onClick={signOut} variant="outline">
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
};

const Home = () => {
  const session = home.useLoaderData();
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      {session.person === null ? (
        <SignIn key={session.problem ?? "signed-out"} session={session} />
      ) : (
        <SignedIn person={session.person} />
      )}
    </main>
  );
};

export const Route = createFileRoute("/")({
  component: Home,
  loader: async ({ parentMatchPromise }) => {
    const root = await parentMatchPromise;
    return loadSession(root.loaderData?.apiUrl ?? "");
  },
  // The key lives in the browser, so this route never renders on the Worker.
  ssr: false,
});
