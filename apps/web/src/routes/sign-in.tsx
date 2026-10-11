import {
  createFileRoute,
  getRouteApi,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { Problem } from "@/components/problem";
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
import { Separator } from "@/components/ui/separator";
import { formField } from "@/lib/form";
import { problemFor } from "@/lib/orbis";
import type { ApiResult } from "@/lib/orbis";
import {
  joinGroup,
  normalizeSignInCode,
  redeemSignInCode,
} from "@/lib/sign-in";
import { readKey, storeKey } from "@/lib/stored-key";

const SignInSearch = Schema.Struct({
  notice: Schema.optionalKey(Schema.Literal("expired")),
});

const signInRoute = getRouteApi("/sign-in");

type Attempt =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly problem: string };

const refuse = (problem: string): Attempt => ({ ok: false, problem });

const attempted = (result: ApiResult<{ readonly key: string }>): Attempt =>
  result.ok ? { key: result.value.key, ok: true } : refuse(problemFor(result));

/** One way in: its fields, its own problem line, and one submit button. */
const SignInForm = ({
  children,
  description,
  onSubmit,
  pendingLabel,
  submitLabel,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly onSubmit: (form: FormData) => Promise<Attempt>;
  readonly pendingLabel: string;
  readonly submitLabel: string;
  readonly title: string;
}) => {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const result = await onSubmit(new FormData(event.currentTarget));
    if (!result.ok) {
      setProblem(result.problem);
      setPending(false);
      return;
    }
    storeKey(result.key);
    await navigate({ to: "/" });
  };
  return (
    <form aria-label={title} className="flex flex-col gap-4" onSubmit={submit}>
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{title}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
      <Problem message={problem} />
      <Button disabled={pending} type="submit">
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
};

const SignIn = () => {
  const { apiUrl } = signInRoute.useRouteContext();
  const { notice } = signInRoute.useSearch();
  const redeem = async (form: FormData) => {
    const code = normalizeSignInCode(formField(form, "code"));
    return code.length === 8
      ? attempted(await redeemSignInCode(apiUrl, code))
      : refuse("Enter the eight-character code from your other device.");
  };
  const join = async (form: FormData) => {
    const username = formField(form, "username");
    const passcode = formField(form, "passcode");
    return username === "" || passcode === ""
      ? refuse("Choose a username and enter the Group Passcode.")
      : attempted(await joinGroup(apiUrl, username, passcode));
  };
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>Sign in to Orbis</h1>
          </CardTitle>
          {notice === "expired" ? (
            <CardDescription className="text-destructive" role="alert">
              Your saved key no longer works. Sign in again.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <SignInForm
            description="On a device where you use Orbis, open Devices and choose Sign in another device."
            onSubmit={redeem}
            pendingLabel="Signing in…"
            submitLabel="Sign in"
            title="Sign in with a code"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="sign-in-code">Sign-in code</Label>
              <Input
                autoCapitalize="characters"
                autoComplete="one-time-code"
                className="font-mono tracking-widest uppercase"
                id="sign-in-code"
                maxLength={20}
                name="code"
                placeholder="ABCD-EFGH"
                spellCheck={false}
              />
            </div>
          </SignInForm>
          <Separator />
          <SignInForm
            description="New here? Ask the Host for the Group Passcode."
            onSubmit={join}
            pendingLabel="Joining…"
            submitLabel="Join"
            title="Join Orbis"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                autoCapitalize="none"
                autoComplete="username"
                id="username"
                maxLength={40}
                name="username"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="passcode">Group Passcode</Label>
              <Input
                autoCapitalize="none"
                autoComplete="off"
                id="passcode"
                maxLength={100}
                name="passcode"
                spellCheck={false}
              />
            </div>
          </SignInForm>
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
