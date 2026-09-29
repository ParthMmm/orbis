import {
  createFileRoute,
  getRouteApi,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { Schema } from "effect";
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
import { FAILURE_MESSAGES, fetchMe } from "@/lib/orbis";
import { readKey, storeKey } from "@/lib/stored-key";

const SignInSearch = Schema.Struct({
  notice: Schema.optionalKey(Schema.Literal("expired")),
});

const signInRoute = getRouteApi("/sign-in");

const EXPIRED = "Your saved key no longer works. Paste a new one.";

const SignIn = () => {
  const { apiUrl } = signInRoute.useRouteContext();
  const { notice } = signInRoute.useSearch();
  const navigate = useNavigate();
  const [problem, setProblem] = useState(notice === "expired" ? EXPIRED : null);
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
    const me = await fetchMe({ apiUrl, key });
    if (!me.ok) {
      setProblem(FAILURE_MESSAGES[me.failure]);
      setPending(false);
      return;
    }
    storeKey(key);
    await navigate({ to: "/" });
  };
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>Sign in to Orbis</h1>
          </CardTitle>
          <CardDescription>
            Paste the API key your Host sent you.
          </CardDescription>
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
    </main>
  );
};

export const Route = createFileRoute("/sign-in")({
  beforeLoad: () => {
    if (readKey() !== null) {
      throw redirect({ to: "/" });
    }
  },
  component: SignIn,
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(SignInSearch),
});
