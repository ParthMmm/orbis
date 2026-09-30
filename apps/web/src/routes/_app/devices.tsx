import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { listDevices, revokeDevice } from "@/lib/devices";
import type { Device } from "@/lib/devices";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult } from "@/lib/orbis";
import { forgetKey } from "@/lib/stored-key";
import type { Session } from "@/routes/_app";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const formatDate = (iso: string) => dateFormat.format(new Date(iso));

const DeviceRow = ({
  device,
  session,
}: {
  readonly device: Device;
  readonly session: Session;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const revoke = async () => {
    setPending(true);
    setProblem(null);
    const result = await revokeDevice(session, device.id);
    if (!result.ok) {
      setProblem(FAILURE_MESSAGES[result.failure]);
      setPending(false);
      return;
    }
    if (device.current) {
      forgetKey();
      await navigate({ to: "/sign-in" });
      return;
    }
    setOpen(false);
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
          Added {formatDate(device.addedAt)} ·{" "}
          {device.lastUsedAt === null
            ? "Never used"
            : `Last used ${formatDate(device.lastUsedAt)}`}
        </p>
      </div>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogTrigger
          render={
            <Button
              aria-label={`Revoke ${device.label}`}
              size="sm"
              variant="outline"
            />
          }
        >
          Revoke
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {device.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {device.current
                ? "This is the device you are using. Revoking it signs you out here, and you need a new key to sign in again."
                : "That device is signed out the next time it contacts Orbis."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {problem === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={revoke}
              variant="destructive"
            >
              {pending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
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
      <CardContent>
        {devices.ok ? (
          <ul aria-label="Your devices" className="divide-y">
            {devices.value.devices.map((device) => (
              <DeviceRow device={device} key={device.id} session={session} />
            ))}
          </ul>
        ) : (
          <p className="text-destructive text-sm" role="alert">
            {FAILURE_MESSAGES[devices.failure]}
          </p>
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
