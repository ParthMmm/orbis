import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Problem } from "@/components/problem";
import { SignInCode } from "@/components/sign-in-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate, lastUsedText } from "@/lib/dates";
import { listDevices, requestSignInCode, revokeDevice } from "@/lib/devices";
import type { Device } from "@/lib/devices";
import { problemFor } from "@/lib/orbis";
import type { ApiResult } from "@/lib/orbis";
import type { IssuedSignInCode } from "@/lib/sign-in";
import { forgetKey } from "@/lib/stored-key";
import { useApiCall } from "@/lib/use-api-call";
import type { Session } from "@/routes/_app";

const DeviceRow = ({
  device,
  session,
}: {
  readonly device: Device;
  readonly session: Session;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const revoked = async () => {
    if (device.current) {
      forgetKey();
      await navigate({ to: "/sign-in" });
      return;
    }
    await router.invalidate();
  };
  return (
    <li className="flex items-center gap-4 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate font-medium">{device.label}</h2>
          {device.current ? (
            <Badge variant="secondary">This device</Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">
          Added {formatDate(device.addedAt)} · {lastUsedText(device.lastUsedAt)}
        </p>
      </div>
      <ConfirmDialog
        action="Revoke"
        call={() => revokeDevice(session, device.id)}
        description={
          device.current
            ? "This is the device you are using. Revoking it signs you out here. To sign in again, use a Sign-in Code from another device."
            : "That device is signed out the next time it contacts Orbis."
        }
        label={`Revoke ${device.label}`}
        onDone={revoked}
        pendingAction="Revoking…"
        title={`Revoke ${device.label}?`}
        trigger="Revoke"
      />
    </li>
  );
};

const SignInAnotherDevice = ({ session }: { readonly session: Session }) => {
  const [code, setCode] = useState<IssuedSignInCode | null>(null);
  const { busy, problem, run } = useApiCall();
  const request = async () => {
    const issued = await run(() => requestSignInCode(session));
    if (issued !== null) {
      setCode(issued);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {code === null ? null : (
        <>
          <SignInCode issued={code} label="Your Sign-in Code" />
          <p className="text-muted-foreground text-sm">
            On the new device, open Orbis, choose Sign in with a code, and type
            this code.
          </p>
        </>
      )}
      <Problem message={problem} />
      <Button
        className="self-start"
        disabled={busy}
        onClick={request}
        variant={code === null ? "default" : "outline"}
      >
        {code === null ? "Sign in another device" : "Get a new code"}
      </Button>
    </div>
  );
};

const Devices = ({
  devices,
  session,
}: {
  readonly devices: ApiResult<{ readonly devices: readonly Device[] }>;
  readonly session: Session;
}) => (
  <main className="mx-auto w-full max-w-3xl p-6">
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-2xl">Devices</h1>
        </CardTitle>
        <CardDescription>
          Each device signs in with its own key. Revoke a device you lost or no
          longer use.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SignInAnotherDevice session={session} />
        {devices.ok ? (
          <ul aria-label="Your devices" className="divide-y">
            {devices.value.devices.map((device) => (
              <DeviceRow device={device} key={device.id} session={session} />
            ))}
          </ul>
        ) : (
          <Problem message={problemFor(devices)} />
        )}
      </CardContent>
    </Card>
  </main>
);

export const Route = createFileRoute("/_app/devices")({
  component: () => (
    <Devices
      devices={Route.useLoaderData()}
      session={Route.useRouteContext().session}
    />
  ),
  loader: ({ context }) => listDevices(context.session),
});
