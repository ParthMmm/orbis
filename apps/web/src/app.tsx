import type { SavedSet } from "@orbis/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { api, ApiFailureError, streamUrl } from "./api";

const KEY_STORAGE = "orbis.apiKey";

type Session =
  | { kind: "key-entry"; explanation: string }
  | { kind: "library"; key: string; username: string };
type WebListQuery = Parameters<ReturnType<typeof api>["list"]>[0];

export const App = () => {
  const [session, setSession] = useState<Session>(() => {
    const key = localStorage.getItem(KEY_STORAGE);
    return key
      ? { key, kind: "library", username: "" }
      : { explanation: "", kind: "key-entry" };
  });
  const [keyInput, setKeyInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [keyError, setKeyError] = useState("");

  const revoked = useCallback(() => {
    localStorage.removeItem(KEY_STORAGE);
    setSession({
      explanation: "Your key was revoked. Enter a new key.",
      kind: "key-entry",
    });
  }, []);

  useEffect(() => {
    if (session.kind !== "library" || session.username) {
      return;
    }
    let live = true;
    const checkKey = async () => {
      try {
        const person = await api(session.key).me();
        if (live) {
          setSession({ ...session, username: person.username });
        }
      } catch (error) {
        if (!live) {
          return;
        }
        if (error instanceof ApiFailureError && error.status === 401) {
          revoked();
        } else {
          setKeyError("Could not reach Orbis. Try again.");
        }
      }
    };
    checkKey();
    return () => {
      live = false;
    };
  }, [revoked, session]);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = keyInput.trim();
    if (!key) {
      setKeyError("Paste your API key.");
      return;
    }
    setConnecting(true);
    setKeyError("");
    try {
      const person = await api(key).me();
      localStorage.setItem(KEY_STORAGE, key);
      setSession({ key, kind: "library", username: person.username });
      setKeyInput("");
    } catch (error) {
      setKeyError(
        error instanceof ApiFailureError && error.status === 401
          ? "Check your key and try again."
          : "Could not reach Orbis. Try again."
      );
    } finally {
      setConnecting(false);
    }
  };

  if (session.kind === "key-entry") {
    return (
      <main className="entry-shell">
        <form className="entry-card" onSubmit={connect}>
          <p className="eyebrow">ORBIS</p>
          <h1>Your music, wherever you are.</h1>
          <p>Paste the API key from your Host to open your Library.</p>
          {session.explanation && (
            <p role="alert" className="error">
              {session.explanation}
            </p>
          )}
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck="false"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            aria-invalid={Boolean(keyError)}
            aria-describedby={keyError ? "key-error" : undefined}
          />
          {keyError && (
            <p id="key-error" className="error">
              {keyError}
            </p>
          )}
          <button type="submit" disabled={connecting}>
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </form>
      </main>
    );
  }
  return (
    // eslint-disable-next-line no-use-before-define
    <LibraryView
      key={session.key}
      session={session}
      onRevoked={revoked}
      onDisconnect={() => {
        localStorage.removeItem(KEY_STORAGE);
        setSession({ explanation: "", kind: "key-entry" });
      }}
    />
  );
};

const LibraryView = ({
  session,
  onRevoked,
  onDisconnect,
}: {
  session: Extract<Session, { kind: "library" }>;
  onRevoked: () => void;
  onDisconnect: () => void;
}) => {
  const [sets, setSets] = useState<SavedSet[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"" | "youtube" | "soundcloud">("");
  const [tag, setTag] = useState("");
  const [message, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<{ set: SavedSet; src: string } | null>(
    null
  );
  const lastReport = useRef(0);
  const client = api(session.key);

  const handleError = useCallback(
    (failure: Error, fallback: string) => {
      if (failure instanceof ApiFailureError && failure.status === 401) {
        onRevoked();
      } else {
        setError(fallback);
      }
    },
    [onRevoked]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const filters: WebListQuery = {};
      if (query) {
        filters.q = query;
      }
      if (source) {
        filters.source = source;
      }
      if (tag) {
        filters.tag = [tag];
      }
      const [library, tagResponse] = await Promise.all([
        api(session.key).list(filters),
        api(session.key).tags(),
      ]);
      setSets(library.sets);
      setTags([...tagResponse.tags]);
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Orbis could not load your Library. Try again.");
      } else {
        setError("Orbis could not load your Library. Try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [session.key, query, source, tag, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  const reportPosition = async (seconds: number) => {
    if (!playing || !Number.isFinite(seconds)) {
      return;
    }
    try {
      await client.position(
        playing.set.id,
        Math.max(0, Math.min(604_800, seconds))
      );
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Could not report playback position.");
      } else {
        setError("Could not report playback position.");
      }
    }
  };

  const play = async (set: SavedSet) => {
    setError("");
    try {
      await client.play(set.id);
      const grant = await client.grant(set.id);
      setPlaying({ set, src: streamUrl(set.id, grant.url) });
      lastReport.current = 0;
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Could not start playback.");
      } else {
        setError("Could not start playback.");
      }
    }
  };

  return (
    <>
      <a className="skip-link" href="#library">
        Skip to Library
      </a>
      <header className="site-header">
        <div className="brand">ORBIS</div>
        <div className="identity">
          <span>{session.username}</span>
          <button type="button" onClick={onDisconnect}>
            Change key
          </button>
        </div>
      </header>
      <main id="library" className="library-shell">
        <div className="page-title">
          <div>
            <p className="eyebrow">YOUR COLLECTION</p>
            <h1>Your library</h1>
          </div>
          <button
            type="button"
            onClick={() => {
              load();
            }}
          >
            Refresh library
          </button>
        </div>
        <div className="filter-row">
          <label>
            Search library
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Title, creator, or link"
            />
          </label>
          <label>
            Source
            <select
              value={source}
              onChange={(event) =>
                setSource(
                  event.target.value === "youtube" ||
                    event.target.value === "soundcloud"
                    ? event.target.value
                    : ""
                )
              }
            >
              <option value="">All sources</option>
              <option value="youtube">YouTube</option>
              <option value="soundcloud">SoundCloud</option>
            </select>
          </label>
          <label>
            Tag
            <select
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            >
              <option value="">All tags</option>
              {tags.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="result-count" role="status">
          {loading
            ? "Loading…"
            : `${sets.length} ${sets.length === 1 ? "Set" : "Sets"}`}
        </p>
        {message && (
          <p role="alert" className="error">
            {message}
          </p>
        )}
        {!loading && sets.length === 0 && (
          <p className="empty">No Sets match these filters.</p>
        )}
        <ul className="set-grid">
          {sets.map((set) => (
            <li className="set-card" key={set.id}>
              <div className="artwork">
                {set.artworkUrl ? (
                  <img src={set.artworkUrl} alt="" loading="lazy" />
                ) : (
                  <span aria-hidden="true">♪</span>
                )}
              </div>
              <div className="set-copy">
                <p className="set-source">
                  {set.source === "youtube" ? "YouTube" : "SoundCloud"}
                </p>
                <h2>{set.title}</h2>
                <p>{set.creator ?? "Unknown creator"}</p>
                {set.tags.length > 0 && (
                  <p className="set-tags">{set.tags.join(" · ")}</p>
                )}
                <button
                  type="button"
                  disabled={set.downloadState !== "ready"}
                  onClick={() => {
                    play(set);
                  }}
                >
                  {set.downloadState === "ready"
                    ? `Play ${set.title}`
                    : "Audio not ready"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </main>
      {playing && (
        <section className="player" aria-label="Audio player">
          <div>
            <strong>{playing.set.title}</strong>
            <span>{playing.set.creator}</span>
          </div>
          <audio
            controls
            autoPlay
            src={playing.src}
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime =
                playing.set.playbackPositionSeconds;
            }}
            onSeeked={(event) => {
              reportPosition(event.currentTarget.currentTime);
            }}
            onPause={(event) => {
              reportPosition(event.currentTarget.currentTime);
            }}
            onTimeUpdate={(event) => {
              const now = Date.now();
              if (now - lastReport.current >= 15_000) {
                lastReport.current = now;
                reportPosition(event.currentTarget.currentTime);
              }
            }}
            onEnded={async () => {
              await reportPosition(0);
              try {
                await client.complete(playing.set.id);
              } catch (error) {
                if (error instanceof Error) {
                  handleError(error, "Could not finish playback.");
                } else {
                  setError("Could not finish playback.");
                }
              }
            }}
          />
        </section>
      )}
    </>
  );
};
