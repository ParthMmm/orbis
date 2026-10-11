import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { Problem } from "@/components/problem";
import { RouteProblem } from "@/components/route-problem";
import { SignInCode } from "@/components/sign-in-code";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  createKey,
  loadAdmin,
  removePerson,
  revokeKey,
  setPasscode,
  signInCodeFor,
} from "@/lib/admin";
import type { AdminData, AdminKey, AdminPerson } from "@/lib/admin";
import { formField } from "@/lib/form";
import { problemFor } from "@/lib/orbis";
import type { ApiResult } from "@/lib/orbis";
import type { IssuedSignInCode } from "@/lib/sign-in";
import type { Session } from "@/routes/_app";

/**
 * One section's admin calls. `run` keeps a failure for the section to show;
 * `change` also reloads the page's data after a call that changed the Group.
 */
const useAdminCall = () => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async <A,>(
    call: () => Promise<ApiResult<A>>
  ): Promise<A | null> => {
    setBusy(true);
    setProblem(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setProblem(problemFor(result));
      return null;
    }
    return result.value;
  };
  const change = async <A,>(
    call: () => Promise<ApiResult<A>>
  ): Promise<A | null> => {
    const value = await run(call);
    if (value !== null) {
      await router.invalidate();
    }
    return value;
  };
  return { busy, change, problem, refuse: setProblem, run };
};

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

const Passcode = ({
  passcode,
  session,
}: {
  readonly passcode: string | null;
  readonly session: Session;
}) => {
  const { busy, change, problem, refuse } = useAdminCall();
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const next = formField(new FormData(form), "passcode");
    if (next === "") {
      refuse("Enter a passcode, or choose Close joining.");
      return;
    }
    if ((await change(() => setPasscode(session, next))) !== null) {
      form.reset();
    }
  };
  return (
    <Section
      description="Friends join with this passcode. Changing it does not sign anyone out."
      id="passcode-title"
      title="Group Passcode"
    >
      {passcode === null ? (
        <p>Joining is closed.</p>
      ) : (
        <p>
          Passcode:{" "}
          <code className="bg-muted rounded-lg px-2 py-1 font-mono select-all">
            {passcode}
          </code>
        </p>
      )}
      <form className="flex flex-col gap-2" onSubmit={save}>
        <Label htmlFor="new-passcode">New passcode</Label>
        <div className="flex gap-2">
          <Input
            autoComplete="off"
            id="new-passcode"
            maxLength={100}
            name="passcode"
            required
            spellCheck={false}
          />
          <Button disabled={busy} type="submit">
            Save
          </Button>
        </div>
      </form>
      {passcode === null ? null : (
        <Button
          className="self-start"
          disabled={busy}
          onClick={() => change(() => setPasscode(session, null))}
          variant="outline"
        >
          Close joining
        </Button>
      )}
      <Problem message={problem} />
    </Section>
  );
};

/** A destructive action behind a confirmation dialog. */
const Confirm = ({
  action,
  busy,
  description,
  label,
  onConfirm,
  title,
  trigger,
}: {
  readonly action: string;
  readonly busy: boolean;
  readonly description: string;
  readonly label: string;
  readonly onConfirm: () => void;
  readonly title: string;
  readonly trigger: string;
}) => (
  <AlertDialog>
    <AlertDialogTrigger
      aria-label={label}
      disabled={busy}
      render={<Button size="sm" variant="outline" />}
    >
      {trigger}
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} variant="destructive">
          {action}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

const PersonRow = ({
  person,
  session,
}: {
  readonly person: AdminPerson;
  readonly session: Session;
}) => {
  const { busy, change, problem, run } = useAdminCall();
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
          aria-label={`Show sign-in code for ${person.username}`}
          disabled={busy}
          onClick={showCode}
          size="sm"
          variant="outline"
        >
          Show sign-in code
        </Button>
        {isHost ? null : (
          <Confirm
            action="Remove"
            busy={busy}
            description="This deletes their keys, Library, Playlists, Listening Queue, and Listen History. You cannot undo it."
            label={`Remove ${person.username}`}
            onConfirm={() => change(() => removePerson(session, person.id))}
            title={`Remove ${person.username}?`}
            trigger={`Remove ${person.username}`}
          />
        )}
      </div>
      {code === null ? null : (
        <SignInCode
          issued={code}
          label={`Sign-in code for ${person.username}`}
        />
      )}
      <Problem message={problem} />
    </li>
  );
};

const lastUsed = (key: AdminKey): string =>
  key.lastUsedAt === null
    ? "Never used"
    : `Last used ${new Date(key.lastUsedAt).toLocaleString()}`;

const CreatedKey = ({
  onDone,
  token,
}: {
  readonly onDone: () => void;
  readonly token: string;
}) => {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
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
  const { busy, change, problem, refuse } = useAdminCall();
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
                  {owner} · {lastUsed(key)}
                </span>
              </div>
              <Confirm
                action="Revoke"
                busy={busy}
                description={`Whatever uses this key is signed out as ${owner} the next time it contacts Orbis.`}
                label={`Revoke ${key.label} for ${owner}`}
                onConfirm={() => change(() => revokeKey(session, key.id))}
                title={`Revoke ${key.label}?`}
                trigger="Revoke"
              />
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
              required
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
      description="Show a sign-in code to add a device for someone, or to let a friend who lost every device back in."
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
