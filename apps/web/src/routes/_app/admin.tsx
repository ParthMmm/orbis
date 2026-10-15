import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Problem } from "@/components/problem";
import { RouteProblem } from "@/components/route-problem";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  closeJoining,
  createKey,
  loadAdmin,
  newPasscode,
  removePerson,
  revokeKey,
  signInCodeFor,
} from "@/lib/admin";
import type { AdminData, AdminKey, AdminPerson } from "@/lib/admin";
import { lastUsedText } from "@/lib/dates";
import { formField } from "@/lib/form";
import type { IssuedSignInCode } from "@/lib/sign-in";
import { useApiCall } from "@/lib/use-api-call";
import type { Session } from "@/routes/_app";

const Section = ({
  children,
  description,
  id,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly id: string;
  readonly title: string;
}) => (
  <Card aria-labelledby={id} role="region">
    <CardHeader>
      <CardTitle>
        <h2 id={id}>{title}</h2>
      </CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">{children}</CardContent>
  </Card>
);

const useCopy = (text: string) => {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return { copy, copyText };
};

const OpenPasscode = ({
  busy,
  change,
  passcode,
  session,
}: {
  readonly busy: boolean;
  readonly change: ReturnType<typeof useApiCall>["change"];
  readonly passcode: string;
  readonly session: Session;
}) => {
  const router = useRouter();
  const { copy, copyText } = useCopy(passcode);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <code
          aria-label="Group Passcode"
          className="bg-muted rounded-lg px-2 py-1 font-mono text-lg tracking-widest select-all"
        >
          {passcode}
        </code>
        <Button onClick={copyText} size="sm">
          {copy === "copied" ? "Copied" : "Copy passcode"}
        </Button>
      </div>
      {copy === "failed" ? (
        <p className="text-destructive text-sm">
          Could not copy the passcode. Select and copy it instead.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ConfirmDialog
          action="New passcode"
          call={() => newPasscode(session)}
          description="The passcode you shared stops working. People who joined stay signed in."
          label="New passcode"
          onDone={() => router.invalidate()}
          pendingAction="Making…"
          title="Make a new passcode?"
          trigger="New passcode"
        />
        <Button
          disabled={busy}
          onClick={() => change(() => closeJoining(session))}
          size="sm"
          variant="outline"
        >
          Close joining
        </Button>
      </div>
    </>
  );
};

const Passcode = ({
  passcode,
  session,
}: {
  readonly passcode: string | null;
  readonly session: Session;
}) => {
  const { busy, change, problem } = useApiCall();
  return (
    <Section
      description="Orbis makes a random passcode. Friends join with it. A new passcode does not sign anyone out."
      id="passcode-title"
      title="Group Passcode"
    >
      {passcode === null ? (
        <>
          <p>Joining is closed.</p>
          <Button
            className="self-start"
            disabled={busy}
            onClick={() => change(() => newPasscode(session))}
          >
            Open joining
          </Button>
        </>
      ) : (
        <OpenPasscode
          busy={busy}
          change={change}
          passcode={passcode}
          session={session}
        />
      )}
      <Problem message={problem} />
    </Section>
  );
};

const PersonRow = ({
  person,
  session,
}: {
  readonly person: AdminPerson;
  readonly session: Session;
}) => {
  const router = useRouter();
  const { busy, problem, run } = useApiCall();
  const [code, setCode] = useState<IssuedSignInCode | null>(null);
  const isHost = person.id === session.person.id;
  const showCode = async () => {
    const issued = await run(() => signInCodeFor(session, person.id));
    if (issued !== null) {
      setCode(issued);
    }
  };
  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-medium">{person.username}</h3>
        {isHost ? <Badge variant="secondary">You</Badge> : null}
        <Button
          aria-label={`Show Sign-in Code for ${person.username}`}
          disabled={busy}
          onClick={showCode}
          size="sm"
          variant="outline"
        >
          Show Sign-in Code
        </Button>
        {isHost ? null : (
          <ConfirmDialog
            action="Remove"
            call={() => removePerson(session, person.id)}
            description="This deletes their keys, Library, Playlists, Listening Queue, and Listen History. You cannot undo it."
            label={`Remove ${person.username}`}
            onDone={() => router.invalidate()}
            pendingAction="Removing…"
            title={`Remove ${person.username}?`}
            trigger={`Remove ${person.username}`}
          />
        )}
      </div>
      {code === null ? null : (
        <SignInCode
          issued={code}
          label={`Sign-in Code for ${person.username}`}
        />
      )}
      <Problem message={problem} />
    </li>
  );
};

const CreatedKey = ({
  onDone,
  token,
}: {
  readonly onDone: () => void;
  readonly token: string;
}) => {
  const { copy, copyText: copyKey } = useCopy(token);
  return (
    <div className="bg-muted flex flex-col gap-3 rounded-2xl p-4" role="status">
      <p className="text-sm">
        Copy this key now. Orbis will not show it again.
      </p>
      <code className="bg-background rounded-lg p-2 text-xs break-all select-all">
        {token}
      </code>
      {copy === "failed" ? (
        <p className="text-destructive text-sm">
          Could not copy the key. Select and copy it instead.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={copyKey} size="sm">
          {copy === "copied" ? "Copied" : "Copy key"}
        </Button>
        <Button onClick={onDone} size="sm" variant="outline">
          Done
        </Button>
      </div>
    </div>
  );
};

const Keys = ({
  keys,
  people,
  session,
}: {
  readonly keys: readonly AdminKey[];
  readonly people: readonly AdminPerson[];
  readonly session: Session;
}) => {
  const router = useRouter();
  const { busy, change, problem, refuse } = useApiCall();
  const [token, setToken] = useState<string | null>(null);
  const usernames = new Map(
    people.map((person) => [person.id, person.username])
  );
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const personId = formField(data, "personId");
    const label = formField(data, "label");
    if (label === "") {
      refuse("Name the key, such as Raycast.");
      return;
    }
    const created = await change(() => createKey(session, personId, label));
    if (created !== null) {
      form.reset();
      setToken(created.token);
    }
  };
  return (
    <Section
      description="Every signed-in device has a key. Create one by hand only for a client that cannot sign in with a code, such as Raycast."
      id="keys-title"
      title="Keys"
    >
      <ul aria-label="Keys" className="divide-y">
        {keys.map((key) => {
          const owner = usernames.get(key.personId) ?? key.personId;
          return (
            <li className="flex items-center gap-2 py-3" key={key.id}>
              <div className="mr-auto flex min-w-0 flex-col">
                <span className="truncate font-medium">{key.label}</span>
                <span className="text-muted-foreground text-xs">
                  {key.scope === "node" ? "Audio node" : owner} ·{" "}
                  {lastUsedText(key.lastUsedAt)}
                </span>
              </div>
              {/* Vanta's audio node stops serving audio without its key. */}
              {key.scope === "node" ? null : (
                <ConfirmDialog
                  action="Revoke"
                  call={() => revokeKey(session, key.id)}
                  description={`Whatever uses this key is signed out as ${owner} the next time it contacts Orbis.`}
                  label={`Revoke ${key.label} for ${owner}`}
                  onDone={() => router.invalidate()}
                  pendingAction="Revoking…"
                  title={`Revoke ${key.label}?`}
                  trigger="Revoke"
                />
              )}
            </li>
          );
        })}
      </ul>
      <form className="flex flex-col gap-2" onSubmit={create}>
        <div className="flex flex-wrap gap-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="key-person">Person</Label>
            <NativeSelect id="key-person" name="personId">
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.username}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <Label htmlFor="key-label">Key label</Label>
            <Input
              autoComplete="off"
              id="key-label"
              maxLength={100}
              name="label"
            />
          </div>
        </div>
        <Button className="self-start" disabled={busy} type="submit">
          Create key
        </Button>
      </form>
      {token === null ? null : (
        <CreatedKey onDone={() => setToken(null)} token={token} />
      )}
      <Problem message={problem} />
    </Section>
  );
};

const AdminPage = ({
  data,
  session,
}: {
  readonly data: AdminData;
  readonly session: Session;
}) => (
  <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
    <h1 className="text-2xl font-medium">Admin</h1>
    <Passcode passcode={data.passcode} session={session} />
    <Section
      description="Show a Sign-in Code to sign in a device for any Person."
      id="people-title"
      title="People"
    >
      <ul aria-label="People in the Group" className="divide-y">
        {data.people.map((person) => (
          <PersonRow key={person.id} person={person} session={session} />
        ))}
      </ul>
    </Section>
    <Keys keys={data.keys} people={data.people} session={session} />
  </main>
);

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (!context.session.person.host) {
      throw redirect({ to: "/" });
    }
  },
  // The route hands its own context and data down, which keeps their types exact.
  component: () => (
    <AdminPage
      data={Route.useLoaderData()}
      session={Route.useRouteContext().session}
    />
  ),
  errorComponent: RouteProblem,
  loader: ({ context }) => loadAdmin(context.session),
});
