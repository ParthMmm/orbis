import { WarningIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { linkProblem } from "@/lib/device-link";
import { callOrbis } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";

type Step =
  | { readonly kind: "entering" }
  | {
      readonly kind: "confirming";
      readonly code: string;
      readonly label: string;
    }
  | { readonly kind: "approved"; readonly label: string };

/**
 * Approves a Device Link (ADR 0016). The Person sees the new device's name and a
 * warning before approving, because approving hands that device a key to their
 * Library. A QR code opens this page with the code in the fragment.
 */
const AddDevice = ({ credentials }: { readonly credentials: Credentials }) => {
  const [code, setCode] = useState(() =>
    decodeURIComponent(window.location.hash.slice(1))
  );
  const [step, setStep] = useState<Step>({ kind: "entering" });
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const lookup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const userCode = code.trim();
    if (userCode === "") {
      setProblem("Enter the code the new device shows.");
      return;
    }
    setPending(true);
    const result = await callOrbis(credentials, (api) =>
      api.deviceLinks.lookup({ payload: { userCode } })
    );
    setPending(false);
    if (!result.ok) {
      setProblem(linkProblem(result));
      return;
    }
    setProblem(null);
    setStep({ code: userCode, kind: "confirming", label: result.value.label });
  };

  const approve = async (userCode: string) => {
    setPending(true);
    const result = await callOrbis(credentials, (api) =>
      api.deviceLinks.approve({ payload: { userCode } })
    );
    setPending(false);
    if (!result.ok) {
      setProblem(linkProblem(result));
      setStep({ kind: "entering" });
      return;
    }
    setProblem(null);
    setCode("");
    setStep({ kind: "approved", label: result.value.label });
  };

  return (
    <main className="mx-auto w-full max-w-md p-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Add a device</h1>
          </CardTitle>
          <CardDescription>
            Choose Sign in with a code on the new device, then enter the code it
            shows.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step.kind === "entering" ? (
            <form className="flex flex-col gap-4" onSubmit={lookup}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="user-code">Code</Label>
                <Input
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="font-mono tracking-widest uppercase"
                  id="user-code"
                  maxLength={20}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="ABCD-EFGH"
                  spellCheck={false}
                  value={code}
                />
              </div>
              <Button disabled={pending} type="submit">
                {pending ? "Checking…" : "Continue"}
              </Button>
            </form>
          ) : null}
          {step.kind === "confirming" ? (
            <div className="flex flex-col gap-4">
              <Alert>
                <WarningIcon />
                <AlertTitle>Approve only a device in front of you</AlertTitle>
                <AlertDescription>
                  If someone sent you this code, do not approve it. The device
                  gets its own key to your Library.
                </AlertDescription>
              </Alert>
              <p className="text-sm">
                Device name: <span className="font-medium">{step.label}</span>
              </p>
              <div className="flex gap-2">
                <Button disabled={pending} onClick={() => approve(step.code)}>
                  {pending ? "Approving…" : `Approve ${step.label}`}
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => setStep({ kind: "entering" })}
                  variant="outline"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {step.kind === "approved" ? (
            <div className="flex flex-col gap-4">
              <p aria-live="polite" className="text-sm">
                Approved {step.label}. It signs in within a few seconds.
              </p>
              <Button
                onClick={() => setStep({ kind: "entering" })}
                variant="outline"
              >
                Add another device
              </Button>
            </div>
          ) : null}
          {problem === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/_app/link")({
  component: () => <AddDevice credentials={Route.useRouteContext().session} />,
});
