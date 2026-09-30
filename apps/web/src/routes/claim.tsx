import {
  Link,
  createFileRoute,
  getRouteApi,
  useNavigate,
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
import { browserLabel } from "@/lib/device-link";
import {
  SPENT_STATUSES,
  claimInvite,
  claimProblem,
  readInviteCode,
} from "@/lib/invite";
import { readKey, storeKey } from "@/lib/stored-key";

const claimRoute = getRouteApi("/claim");

const Problem = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  );

/**
 * Claims an Invite (ADR 0016). The code comes from the link's fragment, which no
 * server sees. A browser that is already signed in may still claim: the new key
 * replaces the old one, so the page says so first.
 */
const Claim = () => {
  const { apiUrl } = claimRoute.useRouteContext();
  const navigate = useNavigate();
  const [code] = useState(() => readInviteCode(window.location.hash));
  const [signedIn] = useState(() => readKey() !== null);
  const [problem, setProblem] = useState<string | null>(
    code === null
      ? "This link has no Invite code. Open the whole link your Host sent."
      : null
  );
  const [spent, setSpent] = useState(code === null);
  const [pending, setPending] = useState(false);

  const claim = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code === null) {
      return;
    }
    const label = String(
      new FormData(event.currentTarget).get("label") ?? ""
    ).trim();
    if (label === "") {
      setProblem("Name this device.");
      return;
    }
    setPending(true);
    const result = await claimInvite(apiUrl, code, label);
    if (!result.ok) {
      setPending(false);
      setProblem(claimProblem(result));
      setSpent(SPENT_STATUSES.has(result.status ?? 0));
      return;
    }
    storeKey(result.value.key);
    await navigate({ to: "/" });
  };

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>Join Orbis</h1>
          </CardTitle>
          <CardDescription>
            Your Host invited you. Name this device to sign in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {signedIn ? (
            <div className="bg-muted flex flex-col gap-2 rounded-2xl p-4 text-sm">
              <p>
                This browser is already signed in. If you use this Invite, it
                signs in as the invited Person instead.
              </p>
              <Link className="font-medium underline" to="/">
                Keep using Orbis as you are
              </Link>
            </div>
          ) : null}
          {spent ? null : (
            <form className="flex flex-col gap-4" onSubmit={claim}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="device-label">Device name</Label>
                <Input
                  defaultValue={browserLabel(navigator.userAgent)}
                  id="device-label"
                  maxLength={100}
                  name="label"
                />
              </div>
              <Button disabled={pending} type="submit">
                {pending ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          )}
          <Problem message={problem} />
          {spent && !signedIn ? (
            <Link className="text-sm underline" to="/sign-in">
              Sign in another way
            </Link>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/claim")({
  component: Claim,
  // The code and the key live in the browser, so this page never renders on the Worker.
  ssr: false,
});
