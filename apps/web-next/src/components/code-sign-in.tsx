import { useNavigate } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  approvalUrl,
  browserLabel,
  formatUserCode,
  linkProblem,
} from "@/lib/device-link";
import { callOrbisWithoutKey } from "@/lib/orbis";
import { storeKey } from "@/lib/stored-key";

const POLL_MS = 2000;

type Step =
  | { readonly kind: "naming" }
  | {
      readonly kind: "waiting";
      readonly pollSecret: string;
      readonly userCode: string;
    }
  | { readonly kind: "expired" };

const WaitingForApproval = ({ userCode }: { readonly userCode: string }) => {
  const url = approvalUrl(window.location.origin, userCode);
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <p className="text-muted-foreground text-sm">
        On a device where you are signed in, open Add a device and enter this
        code, or scan it.
      </p>
      <output
        aria-label="Your code"
        className="font-mono text-3xl font-medium tracking-widest"
      >
        {formatUserCode(userCode)}
      </output>
      <div className="rounded-lg bg-white p-2">
        <QRCodeSVG size={168} title={url} value={url} />
      </div>
      <p aria-live="polite" className="text-muted-foreground text-sm">
        Waiting for approval…
      </p>
    </div>
  );
};

/**
 * Signs this browser in with a Device Link (ADR 0016): it shows a code, polls until
 * a signed-in device approves it, and stores the key the API returns once.
 */
export const CodeSignIn = ({
  apiUrl,
  onCancel,
}: {
  readonly apiUrl: string;
  readonly onCancel: () => void;
}) => {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ kind: "naming" });
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (step.kind !== "waiting") {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const result = await callOrbisWithoutKey(apiUrl, (api) =>
        api.deviceLinks.poll({ payload: { pollSecret: step.pollSecret } })
      );
      if (cancelled) {
        return;
      }
      if (result.ok && result.value.status === "approved") {
        storeKey(result.value.key);
        await navigate({ to: "/" });
        return;
      }
      if (
        (result.ok && result.value.status === "expired") ||
        (!result.ok && result.status === 404)
      ) {
        setStep({ kind: "expired" });
        return;
      }
      // A pending link, or a passing failure: say why, and keep waiting.
      setProblem(result.ok ? null : linkProblem(result));
      timer = setTimeout(check, POLL_MS);
    };
    timer = setTimeout(check, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiUrl, navigate, step]);

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = String(
      new FormData(event.currentTarget).get("label") ?? ""
    ).trim();
    if (label === "") {
      setProblem("Name this device.");
      return;
    }
    setStarting(true);
    const result = await callOrbisWithoutKey(apiUrl, (api) =>
      api.deviceLinks.start({ payload: { label } })
    );
    setStarting(false);
    if (!result.ok) {
      setProblem(linkProblem(result));
      return;
    }
    setProblem(null);
    setStep({
      kind: "waiting",
      pollSecret: result.value.pollSecret,
      userCode: result.value.userCode,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {step.kind === "naming" ? (
        <form className="flex flex-col gap-4" onSubmit={start}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="device-label">Device name</Label>
            <Input
              defaultValue={browserLabel(navigator.userAgent)}
              id="device-label"
              maxLength={100}
              name="label"
            />
          </div>
          <Button disabled={starting} type="submit">
            {starting ? "Getting a code…" : "Get a code"}
          </Button>
        </form>
      ) : null}
      {step.kind === "waiting" ? (
        <WaitingForApproval userCode={step.userCode} />
      ) : null}
      {step.kind === "expired" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            That code expired before anyone approved it.
          </p>
          <Button onClick={() => setStep({ kind: "naming" })}>
            Start again
          </Button>
        </div>
      ) : null}
      {problem === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      )}
      <Button onClick={onCancel} variant="ghost">
        Use an API key instead
      </Button>
    </div>
  );
};
