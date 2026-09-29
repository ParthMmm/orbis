import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { adminApi, ApiFailureError } from "./api";

const ADMIN_KEY_STORAGE = "orbis.adminKey";
type Person = Awaited<
  ReturnType<ReturnType<typeof adminApi>["people"]>
>["people"][number];
type Key = Awaited<
  ReturnType<ReturnType<typeof adminApi>["keys"]>
>["keys"][number];
type Access =
  | { kind: "locked"; message: string }
  | { kind: "loading"; key: string }
  | { kind: "ready"; key: string; people: readonly Person[] };
type Selection =
  | { kind: "none" }
  | { kind: "loading"; person: Person }
  | { kind: "ready"; person: Person; keys: readonly Key[] };

const failureMessage = (error: Error): string =>
  error instanceof ApiFailureError && [401, 403].includes(error.status ?? 0)
    ? "An admin key is required."
    : "Orbis could not complete that action. Try again.";

export const AdminView = ({ onClose }: { onClose: () => void }) => {
  const [access, setAccess] = useState<Access>(() => {
    const key = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    return key ? { key, kind: "loading" } : { kind: "locked", message: "" };
  });
  const [keyInput, setKeyInput] = useState("");
  const [username, setUsername] = useState("");
  const [label, setLabel] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [issued, setIssued] = useState("");
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (access.kind !== "loading") {
      return;
    }
    const { key } = access;
    let live = true;
    const load = async () => {
      try {
        const { people } = await adminApi(key).people();
        if (!live) {
          return;
        }
        sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
        setAccess({ key, kind: "ready", people });
      } catch (error) {
        if (!live) {
          return;
        }
        sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        setAccess({
          kind: "locked",
          message: failureMessage(
            error instanceof Error ? error : new Error("Request failed")
          ),
        });
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [access]);

  const lockIfDenied = (error: Error) => {
    if (
      error instanceof ApiFailureError &&
      [401, 403].includes(error.status ?? 0)
    ) {
      sessionStorage.removeItem(ADMIN_KEY_STORAGE);
      setAccess({ kind: "locked", message: "An admin key is required." });
      setSelection({ kind: "none" });
      setIssued("");
    } else {
      setMessage(failureMessage(error));
    }
  };

  const unlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = keyInput.trim();
    if (!key) {
      setAccess({ kind: "locked", message: "Paste your admin key." });
      return;
    }
    setKeyInput("");
    setAccess({ key, kind: "loading" });
  };

  const selectPerson = async (person: Person) => {
    if (access.kind !== "ready") {
      return;
    }
    setMessage("");
    setIssued("");
    setCopied(false);
    setSelection({ kind: "loading", person });
    try {
      const response = await adminApi(access.key).keys(person.id);
      setSelection({ keys: response.keys, kind: "ready", person });
    } catch (error) {
      lockIfDenied(
        error instanceof Error ? error : new Error("Request failed")
      );
    }
  };

  const addPerson = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (access.kind !== "ready" || !username.trim() || busy) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const person = await adminApi(access.key).addPerson(username.trim());
      setAccess({ ...access, people: [...access.people, person] });
      setUsername("");
    } catch (error) {
      lockIfDenied(
        error instanceof Error ? error : new Error("Request failed")
      );
    } finally {
      setBusy(false);
    }
  };

  const mintKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      access.kind !== "ready" ||
      selection.kind !== "ready" ||
      !label.trim() ||
      busy
    ) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const created = await adminApi(access.key).addKey(
        selection.person.id,
        label.trim()
      );
      const { token, ...key } = created;
      setSelection({ ...selection, keys: [...selection.keys, key] });
      setIssued(token);
      setCopied(false);
      setLabel("");
    } catch (error) {
      lockIfDenied(
        error instanceof Error ? error : new Error("Request failed")
      );
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (key: Key) => {
    if (access.kind !== "ready" || selection.kind !== "ready" || busy) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await adminApi(access.key).revokeKey(key.id);
      setSelection({
        ...selection,
        keys: selection.keys.filter((item) => item.id !== key.id),
      });
    } catch (error) {
      lockIfDenied(
        error instanceof Error ? error : new Error("Request failed")
      );
    } finally {
      setBusy(false);
    }
  };

  const removePerson = async (person: Person) => {
    if (access.kind !== "ready" || person.id === "host" || busy) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await adminApi(access.key).removePerson(person.id);
      setAccess({
        ...access,
        people: access.people.filter((item) => item.id !== person.id),
      });
      setSelection({ kind: "none" });
      setIssued("");
    } catch (error) {
      lockIfDenied(
        error instanceof Error ? error : new Error("Request failed")
      );
    } finally {
      setBusy(false);
    }
  };

  if (access.kind !== "ready") {
    return (
      <main className="entry-shell">
        <form className="entry-card" onSubmit={unlock}>
          <p className="eyebrow">HOST TOOLS</p>
          <h1>Manage your Group</h1>
          <p>Use the Host admin key. This tab forgets it when you close it.</p>
          <label htmlFor="admin-key">Admin key</label>
          <input
            id="admin-key"
            type="password"
            autoComplete="off"
            spellCheck="false"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            disabled={access.kind === "loading"}
          />
          {access.kind === "locked" && access.message && (
            <p role="alert" className="error">
              {access.message}
            </p>
          )}
          <button type="submit" disabled={access.kind === "loading"}>
            {access.kind === "loading" ? "Checking…" : "Unlock"}
          </button>
          <button type="button" className="text-button" onClick={onClose}>
            Back to Library
          </button>
        </form>
      </main>
    );
  }

  return (
    <>
      <header className="site-header">
        <div className="brand">ORBIS</div>
        <div className="identity">
          <button type="button" onClick={onClose}>
            Back to Library
          </button>
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem(ADMIN_KEY_STORAGE);
              setAccess({ kind: "locked", message: "" });
              setSelection({ kind: "none" });
              setIssued("");
            }}
          >
            Forget admin key
          </button>
        </div>
      </header>
      <main className="admin-shell">
        <p className="eyebrow">HOST TOOLS</p>
        <h1>People</h1>
        {message && (
          <p role="alert" className="error">
            {message}
          </p>
        )}
        <div className="admin-columns">
          <section className="admin-panel" aria-label="People in the Group">
            <h2>Group</h2>
            <ul className="person-list">
              {access.people.map((person) => (
                <li key={person.id}>
                  <span>{person.username}</span>
                  <button
                    type="button"
                    onClick={() => {
                      selectPerson(person);
                    }}
                  >
                    Manage {person.username}
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={addPerson} className="admin-form">
              <label htmlFor="new-person">New Person username</label>
              <div className="form-inline">
                <input
                  id="new-person"
                  value={username}
                  maxLength={40}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <button type="submit" disabled={busy}>
                  Add Person
                </button>
              </div>
            </form>
          </section>
          <section className="admin-panel" aria-label="Selected Person">
            {selection.kind === "none" && (
              <p>Select a Person to manage their keys.</p>
            )}
            {selection.kind === "loading" && (
              <p>Loading {selection.person.username}…</p>
            )}
            {selection.kind === "ready" && (
              <>
                <div className="admin-heading">
                  <h2>{selection.person.username}</h2>
                  {selection.person.id !== "host" && (
                    <button
                      type="button"
                      onClick={() => {
                        removePerson(selection.person);
                      }}
                      disabled={busy}
                    >
                      Remove {selection.person.username}
                    </button>
                  )}
                </div>
                <ul className="key-list">
                  {selection.keys.map((key) => (
                    <li key={key.id}>
                      <div>
                        <strong>{key.label}</strong>
                        <span>
                          Last used{" "}
                          {key.lastUsedAt
                            ? new Date(key.lastUsedAt).toLocaleString()
                            : "never"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          revokeKey(key);
                        }}
                        disabled={busy}
                      >
                        Revoke {key.label}
                      </button>
                    </li>
                  ))}
                </ul>
                <form onSubmit={mintKey} className="admin-form">
                  <label htmlFor="key-label">Key label</label>
                  <div className="form-inline">
                    <input
                      id="key-label"
                      value={label}
                      maxLength={100}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                    <button type="submit" disabled={busy}>
                      Mint key
                    </button>
                  </div>
                </form>
                {issued && (
                  <div className="issued-key" role="status">
                    <p>Copy this key now. Orbis will not show it again.</p>
                    <code>{issued}</code>
                    <div className="form-inline">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(issued);
                            setCopied(true);
                          } catch {
                            setMessage(
                              "Could not copy the key. Select and copy it instead."
                            );
                          }
                        }}
                      >
                        {copied ? "Copied" : "Copy key"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIssued("");
                          setCopied(false);
                        }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </main>
    </>
  );
};
