import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { FormEvent } from "react";

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
import {
  ADMIN_KEY_REQUIRED,
  addPerson,
  forgetAdminKey,
  listPeople,
  listPersonKeys,
  locksAdmin,
  mintKey,
  readAdminKey,
  removePerson,
  revokeKey,
  storeAdminKey,
} from "@/lib/admin";
import type { AdminKey, AdminPerson } from "@/lib/admin";
import { createInvite, inviteUrl } from "@/lib/invite";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiFailure, ApiResult, Credentials } from "@/lib/orbis";

import type { Session } from "../_app";

const HOST_PERSON_ID = "host";

type Access =
  | { readonly kind: "locked"; readonly message: string | null }
  | {
      readonly kind: "ready";
      readonly credentials: Credentials;
      readonly people: readonly AdminPerson[];
    };

type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "loading"; readonly person: AdminPerson }
  | {
      readonly kind: "ready";
      readonly person: AdminPerson;
      readonly keys: readonly AdminKey[];
    };

/** Checks an admin key by listing the Group, and keeps it only if it works. */
const unlockWith = async (apiUrl: string, key: string): Promise<Access> => {
  const credentials = { apiUrl, key };
  const people = await listPeople(credentials);
  if (people.ok) {
    storeAdminKey(key);
    return { credentials, kind: "ready", people: people.value.people };
  }
  forgetAdminKey();
  return {
    kind: "locked",
    message: locksAdmin(people.failure)
      ? ADMIN_KEY_REQUIRED
      : FAILURE_MESSAGES[people.failure],
  };
};

const Problem = ({ message }: { readonly message: string | null }) =>
  message === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      {message}
    </p>
  );

const UnlockForm = ({
  apiUrl,
  message,
  onUnlock,
}: {
  readonly apiUrl: string;
  readonly message: string | null;
  readonly onUnlock: (access: Access) => void;
}) => {
  const [problem, setProblem] = useState(message);
  const [pending, setPending] = useState(false);
  const unlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const key = String(new FormData(form).get("key") ?? "").trim();
    if (key === "") {
      setProblem("Paste your admin key.");
      return;
    }
    setPending(true);
    const access = await unlockWith(apiUrl, key);
    setPending(false);
    if (access.kind === "locked") {
      setProblem(access.message);
      form.reset();
      return;
    }
    onUnlock(access);
  };
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>Manage your Group</h1>
          </CardTitle>
          <CardDescription>
            Use the Host admin key. This tab forgets it when you close it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={unlock}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="admin-key">Admin key</Label>
              <Input
                autoComplete="off"
                disabled={pending}
                id="admin-key"
                name="key"
                spellCheck={false}
                type="password"
              />
            </div>
            <Problem message={problem} />
            <Button disabled={pending} type="submit">
              {pending ? "Checking…" : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
};

const lastUsed = (key: AdminKey): string =>
  key.lastUsedAt === null
    ? "Never used"
    : `Last used ${new Date(key.lastUsedAt).toLocaleString()}`;

/** A key or an Invite link, which Orbis shows once. */
type Issued =
  | { readonly kind: "key"; readonly token: string }
  | {
      readonly kind: "invite";
      readonly url: string;
      readonly expiresAt: string;
      readonly username: string;
    };

const IssuedSecret = ({
  issued,
  onDone,
}: {
  readonly issued: Issued;
  readonly onDone: () => void;
}) => {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const text = issued.kind === "key" ? issued.token : issued.url;
  const noun = issued.kind === "key" ? "key" : "link";
  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <div className="bg-muted flex flex-col gap-3 rounded-2xl p-4" role="status">
      {issued.kind === "key" ? (
        <p className="text-sm">
          Copy this key now. Orbis will not show it again.
        </p>
      ) : (
        <p className="text-sm">
          Send this Invite link to {issued.username} through a channel you
          trust. It signs in one device, and expires{" "}
          {new Date(issued.expiresAt).toLocaleString()}. Orbis will not show it
          again.
        </p>
      )}
      <code
        aria-label={issued.kind === "key" ? "New key" : "Invite link"}
        className="bg-background rounded-lg p-2 text-xs break-all select-all"
      >
        {text}
      </code>
      {copy === "failed" ? (
        <p className="text-destructive text-sm">
          Could not copy the {noun}. Select and copy it instead.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={copySecret} size="sm">
          {copy === "copied" ? "Copied" : `Copy ${noun}`}
        </Button>
        <Button onClick={onDone} size="sm" variant="outline">
          Done
        </Button>
      </div>
    </div>
  );
};

const RemovePerson = ({
  busy,
  person,
  onRemove,
}: {
  readonly busy: boolean;
  readonly person: AdminPerson;
  readonly onRemove: () => void;
}) => (
  <AlertDialog>
    <AlertDialogTrigger
      disabled={busy}
      render={<Button size="sm" variant="destructive" />}
    >
      Remove {person.username}
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove {person.username}?</AlertDialogTitle>
        <AlertDialogDescription>
          This deletes their keys, Library, Playlists, Listening Queue, and
          Listen History. You cannot undo it.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={onRemove} variant="destructive">
          Remove
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

const GroupAdmin = ({
  access,
  onChange,
}: {
  readonly access: Extract<Access, { kind: "ready" }>;
  readonly onChange: (access: Access) => void;
}) => {
  const { credentials, people } = access;
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [issued, setIssued] = useState<Issued | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest selection's key list may land, so a slow reply for one
  // Person never shows under another.
  const selectionRequest = useRef(0);

  const lock = (text: string | null) => {
    forgetAdminKey();
    selectionRequest.current += 1;
    onChange({ kind: "locked", message: text });
  };
  const fail = (failure: ApiFailure) => {
    if (locksAdmin(failure)) {
      lock(ADMIN_KEY_REQUIRED);
      return;
    }
    setMessage(FAILURE_MESSAGES[failure]);
  };
  const run = async <A,>(
    call: () => Promise<ApiResult<A>>,
    onSuccess: (value: A) => void
  ) => {
    setBusy(true);
    setMessage(null);
    const result = await call();
    setBusy(false);
    if (result.ok) {
      onSuccess(result.value);
    } else {
      fail(result.failure);
    }
  };

  const selectPerson = async (person: AdminPerson) => {
    setMessage(null);
    setIssued(null);
    selectionRequest.current += 1;
    const request = selectionRequest.current;
    setSelection({ kind: "loading", person });
    const result = await listPersonKeys(credentials, person.id);
    if (request !== selectionRequest.current) {
      return;
    }
    if (result.ok) {
      setSelection({ keys: result.value.keys, kind: "ready", person });
    } else {
      setSelection({ kind: "none" });
      fail(result.failure);
    }
  };

  const submitPerson = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const username = String(new FormData(form).get("username") ?? "").trim();
    if (username === "" || busy) {
      return;
    }
    await run(
      () => addPerson(credentials, username),
      (person) => {
        form.reset();
        onChange({ ...access, people: [...people, person] });
      }
    );
  };

  const submitKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selection.kind !== "ready" || busy) {
      return;
    }
    const form = event.currentTarget;
    const label = String(new FormData(form).get("label") ?? "").trim();
    if (label === "") {
      return;
    }
    await run(
      () => mintKey(credentials, selection.person.id, label),
      ({ token, ...key }) => {
        form.reset();
        setSelection({ ...selection, keys: [...selection.keys, key] });
        setIssued({ kind: "key", token });
      }
    );
  };

  const invite = async () => {
    if (selection.kind !== "ready" || busy) {
      return;
    }
    const { person } = selection;
    await run(
      () => createInvite(credentials, person.id),
      ({ code, expiresAt }) =>
        setIssued({
          expiresAt,
          kind: "invite",
          url: inviteUrl(window.location.origin, code),
          username: person.username,
        })
    );
  };

  const revoke = async (key: AdminKey) => {
    if (selection.kind !== "ready" || busy) {
      return;
    }
    await run(
      () => revokeKey(credentials, key.id),
      () =>
        setSelection({
          ...selection,
          keys: selection.keys.filter((item) => item.id !== key.id),
        })
    );
  };

  const remove = async (person: AdminPerson) => {
    await run(
      () => removePerson(credentials, person.id),
      () => {
        selectionRequest.current += 1;
        setSelection({ kind: "none" });
        setIssued(null);
        onChange({
          ...access,
          people: people.filter((item) => item.id !== person.id),
        });
      }
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-medium">People</h1>
        <Button onClick={() => lock(null)} size="sm" variant="outline">
          Lock
        </Button>
      </div>
      <Problem message={message} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Group</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul
              aria-label="People in the Group"
              className="flex flex-col gap-2"
            >
              {people.map((person) => (
                <li
                  className="flex items-center justify-between gap-2"
                  key={person.id}
                >
                  <span>{person.username}</span>
                  <Button
                    aria-pressed={
                      selection.kind !== "none" &&
                      selection.person.id === person.id
                    }
                    onClick={() => selectPerson(person)}
                    size="sm"
                    variant="outline"
                  >
                    Manage {person.username}
                  </Button>
                </li>
              ))}
            </ul>
            <form className="flex flex-col gap-2" onSubmit={submitPerson}>
              <Label htmlFor="new-person">New Person username</Label>
              <div className="flex gap-2">
                <Input
                  autoComplete="off"
                  id="new-person"
                  maxLength={40}
                  name="username"
                />
                <Button disabled={busy} type="submit">
                  Add Person
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card aria-label="Selected Person" role="region">
          {selection.kind === "none" ? (
            <CardContent>
              <p className="text-muted-foreground">
                Select a Person to manage their keys.
              </p>
            </CardContent>
          ) : null}
          {selection.kind === "loading" ? (
            <CardContent>
              <p className="text-muted-foreground">
                Loading {selection.person.username}…
              </p>
            </CardContent>
          ) : null}
          {selection.kind === "ready" ? (
            <>
              <CardHeader className="flex items-center justify-between gap-2">
                <CardTitle>
                  <h2>{selection.person.username}</h2>
                </CardTitle>
                {selection.person.id === HOST_PERSON_ID ? null : (
                  <RemovePerson
                    busy={busy}
                    onRemove={() => remove(selection.person)}
                    person={selection.person}
                  />
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {selection.keys.length === 0 ? (
                  <p className="text-muted-foreground">No keys yet.</p>
                ) : (
                  <ul aria-label="Keys" className="flex flex-col gap-2">
                    {selection.keys.map((key) => (
                      <li
                        className="flex items-center justify-between gap-2"
                        key={key.id}
                      >
                        <div className="flex flex-col">
                          <span className="font-medium">{key.label}</span>
                          <span className="text-muted-foreground text-xs">
                            {key.scope === "admin" ? "Admin key · " : ""}
                            {lastUsed(key)}
                          </span>
                        </div>
                        <Button
                          disabled={busy}
                          onClick={() => revoke(key)}
                          size="sm"
                          variant="outline"
                        >
                          Revoke {key.label}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <form className="flex flex-col gap-2" onSubmit={submitKey}>
                  <Label htmlFor="key-label">Key label</Label>
                  <div className="flex gap-2">
                    <Input
                      autoComplete="off"
                      id="key-label"
                      maxLength={100}
                      name="label"
                    />
                    <Button disabled={busy} type="submit">
                      Mint key
                    </Button>
                  </div>
                </form>
                <div className="flex flex-col gap-2">
                  <p className="text-muted-foreground text-sm">
                    An Invite is a link that signs in one device as{" "}
                    {selection.person.username}, without a key to copy.
                  </p>
                  <Button
                    className="self-start"
                    disabled={busy}
                    onClick={invite}
                    variant="outline"
                  >
                    Create Invite
                  </Button>
                </div>
                {issued === null ? null : (
                  <IssuedSecret
                    issued={issued}
                    onDone={() => setIssued(null)}
                  />
                )}
              </CardContent>
            </>
          ) : null}
        </Card>
      </div>
    </main>
  );
};

const AdminPage = ({
  initial,
  session,
}: {
  readonly initial: Access;
  readonly session: Session;
}) => {
  const [access, setAccess] = useState(initial);
  return access.kind === "ready" ? (
    <GroupAdmin access={access} onChange={setAccess} />
  ) : (
    <UnlockForm
      apiUrl={session.apiUrl}
      message={access.message}
      onUnlock={setAccess}
    />
  );
};

export const Route = createFileRoute("/_app/admin")({
  // The route hands its own context and data down, which keeps their types exact.
  component: () => (
    <AdminPage
      initial={Route.useLoaderData()}
      session={Route.useRouteContext().session}
    />
  ),
  // A key kept in this tab unlocks the page again after a reload.
  loader: async ({ context }): Promise<Access> => {
    const key = readAdminKey();
    return key === null
      ? { kind: "locked", message: null }
      : await unlockWith(context.session.apiUrl, key);
  },
});
