import type { SavedSet } from "@orbis/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { AdminView } from "./admin";
import { api, ApiFailureError, streamUrl } from "./api";

const KEY_STORAGE = "orbis.apiKey";

type Session =
  | { kind: "key-entry"; explanation: string }
  | { kind: "library"; key: string; username: string };
type WebListQuery = Parameters<ReturnType<typeof api>["list"]>[0];
type Playlist = Awaited<ReturnType<ReturnType<typeof api>["createPlaylist"]>>;
type Queue = Awaited<ReturnType<ReturnType<typeof api>["queue"]>>["queue"];

export const App = () => {
  const [screen, setScreen] = useState<"library" | "admin">("library");
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

  if (screen === "admin") {
    return <AdminView onClose={() => setScreen("library")} />;
  }

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
          <button
            type="button"
            className="text-button"
            onClick={() => setScreen("admin")}
          >
            Manage people
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
      onManagePeople={() => setScreen("admin")}
    />
  );
};

// eslint-disable-next-line complexity -- The view coordinates the Library, player, and panels.
const LibraryView = ({
  session,
  onRevoked,
  onDisconnect,
  onManagePeople,
}: {
  session: Extract<Session, { kind: "library" }>;
  onRevoked: () => void;
  onDisconnect: () => void;
  onManagePeople: () => void;
}) => {
  const [sets, setSets] = useState<SavedSet[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [social, setSocial] = useState(false);
  const [people, setPeople] = useState<{ id: string; username: string }[]>([]);
  const [friend, setFriend] = useState<{
    listens: Awaited<
      ReturnType<ReturnType<typeof api>["friendListens"]>
    >["listens"];
    playlists: Awaited<
      ReturnType<ReturnType<typeof api>["friendPlaylists"]>
    >["playlists"];
    username: string;
    sets: SavedSet[];
  } | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"" | "youtube" | "soundcloud">("");
  const [tag, setTag] = useState("");
  const [message, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<{
    attempt: number;
    set: SavedSet;
    src: string;
  } | null>(null);
  const [playerError, setPlayerError] = useState("");
  const [retryingAudio, setRetryingAudio] = useState(false);
  const [sourceLink, setSourceLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [autoDownload, setAutoDownload] = useState<boolean | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistName, setPlaylistName] = useState("");
  const [selectedPlaylist, setSelectedPlaylist] = useState<string | null>(null);
  const [members, setMembers] = useState<SavedSet[]>([]);
  const [rename, setRename] = useState("");
  const [queue, setQueue] = useState<Queue | null>(null);
  const [audioStates, setAudioStates] = useState<
    Record<
      string,
      { bytesReceived: number; bytesTotal: number | null; state: string }
    >
  >({});
  const [reconnecting, setReconnecting] = useState(false);

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
      const [library, tagResponse, person, visiblePeople] = await Promise.all([
        api(session.key).list(filters),
        api(session.key).tags(),
        api(session.key).me(),
        api(session.key).people(),
      ]);
      setSets(library.sets);
      setTags([...tagResponse.tags]);
      setSocial(person.social);
      setPeople([...visiblePeople.people]);
      if (!person.social) {
        setFriend(null);
      }
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

  const loadSidebars = useCallback(async () => {
    try {
      const [person, playlistList, queueResponse] = await Promise.all([
        api(session.key).me(),
        api(session.key).playlists(),
        api(session.key).queue(),
      ]);
      setAutoDownload(person.autoDownload);
      setPlaylists([...playlistList.playlists]);
      setQueue(queueResponse.queue);
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Could not load your settings and playlists.");
      }
    }
  }, [session.key, handleError]);

  useEffect(() => {
    void loadSidebars();
  }, [loadSidebars]);

  useEffect(() => {
    if (!selectedPlaylist) {
      setMembers([]);
      return;
    }
    let live = true;
    const loadMembers = async () => {
      try {
        const response = await api(session.key).playlistMembers(
          selectedPlaylist
        );
        if (live) {
          setMembers([...response.sets]);
        }
      } catch (error) {
        if (live && error instanceof Error) {
          handleError(error, "Could not load Playlist.");
        }
      }
    };
    loadMembers();
    return () => {
      live = false;
    };
  }, [selectedPlaylist, session.key, handleError]);

  useEffect(() => {
    const pending = sets.filter(
      (set) =>
        set.downloadState === "queued" ||
        set.downloadState === "downloading" ||
        set.metadataState === "pending"
    );
    if (!pending.length) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const states = await Promise.all(
          pending.map(
            async (set) => [set.id, await client.audioState(set.id)] as const
          )
        );
        setAudioStates(Object.fromEntries(states));
        if (
          pending.some((set) => set.metadataState === "pending") ||
          states.some(
            ([, state]) => state.state === "ready" || state.state === "failed"
          )
        ) {
          void load();
        }
      } catch (error) {
        if (error instanceof Error) {
          handleError(error, "Could not check Download progress.");
        }
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [sets, session.key, load, handleError]);

  const saveSet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await client.save(sourceLink.trim());
      setSourceLink("");
      await load();
      if (result.autoDownloadResult === "queueFull") {
        setError("Download queue is full. You can start this Download later.");
      }
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Could not save Source Link.");
      }
    } finally {
      setSaving(false);
    }
  };

  const download = async (set: SavedSet) => {
    try {
      await client.download(set.id);
      await load();
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Could not start Download.");
      }
    }
  };

  const changeMembers = async (next: SavedSet[]) => {
    if (!selectedPlaylist) {
      return;
    }
    try {
      const response = await client.replaceMembers(
        selectedPlaylist,
        next.map((set) => set.id)
      );
      setMembers([...response.sets]);
      setPlaylists((current) =>
        current.map((playlist) =>
          playlist.id === selectedPlaylist
            ? { ...playlist, setCount: response.sets.length }
            : playlist
        )
      );
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Could not update Playlist.");
      }
    }
  };
  const moveMember = (index: number, direction: -1 | 1) => {
    const other = index + direction;
    const next = [...members];
    const currentSet = next[index];
    const otherSet = next[other];
    if (!currentSet || !otherSet) {
      return;
    }
    next[index] = otherSet;
    next[other] = currentSet;
    void changeMembers(next);
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        await api(session.key).events((current) => {
          setQueue(current);
          setReconnecting(false);
        }, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof ApiFailureError && error.status === 401) {
          onRevoked();
          return;
        }
      }
      if (!controller.signal.aborted) {
        setReconnecting(true);
        timer = setTimeout(connect, 1000);
      }
    };
    connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session.key, onRevoked]);

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
    setPlayerError("");
    try {
      const response = await client.play(set.id);
      setQueue(response.queue);
      const grant = await client.grant(set.id);
      setPlaying({
        attempt: (playing?.attempt ?? 0) + 1,
        set,
        src: streamUrl(set.id, grant.url),
      });
      lastReport.current = 0;
    } catch (error) {
      if (error instanceof Error) {
        handleError(error, "Could not start playback.");
      } else {
        setError("Could not start playback.");
      }
    }
  };

  const retryAudio = async () => {
    if (!playing) {
      return;
    }
    setRetryingAudio(true);
    try {
      const grant = await client.grant(playing.set.id);
      setPlaying({
        ...playing,
        attempt: playing.attempt + 1,
        src: streamUrl(playing.set.id, grant.url),
      });
      setPlayerError("");
    } catch (error) {
      if (error instanceof ApiFailureError && error.status === 401) {
        onRevoked();
      } else {
        setPlayerError("Could not get a new audio link. Try again.");
      }
    } finally {
      setRetryingAudio(false);
    }
  };

  const changeSocial = async (enabled: boolean) => {
    setError("");
    setSocial(enabled);
    try {
      const person = await client.updateMe(enabled);
      setSocial(person.social);
      if (!person.social) {
        setFriend(null);
      }
      const visible = await client.people();
      setPeople([...visible.people]);
    } catch (error) {
      setSocial(!enabled);
      if (error instanceof Error) {
        handleError(error, "Could not change your Social setting.");
      }
    }
  };

  const openFriend = async (person: { id: string; username: string }) => {
    setError("");
    try {
      const [library, friendPlaylists, listens] = await Promise.all([
        client.friendSets(person.id),
        client.friendPlaylists(person.id),
        client.friendListens(person.id),
      ]);
      setFriend({
        listens: listens.listens,
        playlists: friendPlaylists.playlists,
        sets: library.sets,
        username: person.username,
      });
    } catch (error) {
      setFriend(null);
      if (error instanceof Error) {
        handleError(
          error,
          error instanceof ApiFailureError && error.status === 404
            ? "This Person is no longer visible to you."
            : "Could not open this profile."
        );
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
          {session.username === "host" && (
            <button type="button" onClick={onManagePeople}>
              Manage people
            </button>
          )}
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
        <div className="workspace-panels">
          <section className="workspace-panel" aria-labelledby="save-heading">
            <h2 id="save-heading">Save a Set</h2>
            <form onSubmit={saveSet} className="inline-form">
              <label htmlFor="source-link">Source Link</label>
              <input
                id="source-link"
                type="url"
                required
                value={sourceLink}
                onChange={(event) => setSourceLink(event.target.value)}
                placeholder="YouTube or SoundCloud link"
              />
              <button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save Set"}
              </button>
            </form>
            <label className="toggle">
              <input
                type="checkbox"
                checked={autoDownload ?? false}
                disabled={autoDownload === null}
                onChange={async (event) => {
                  const next = event.target.checked;
                  setAutoDownload(next);
                  try {
                    const person = await client.updateAutoDownload(next);
                    setAutoDownload(person.autoDownload);
                  } catch (error) {
                    setAutoDownload(!next);
                    if (error instanceof Error) {
                      handleError(error, "Could not change Auto Download.");
                    }
                  }
                }}
              />
              Auto Download
            </label>
          </section>
          <section
            className="workspace-panel"
            aria-labelledby="playlists-heading"
          >
            <h2 id="playlists-heading">Playlists</h2>
            <form
              className="inline-form"
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  const playlist = await client.createPlaylist(
                    playlistName.trim()
                  );
                  setPlaylists((current) => [...current, playlist]);
                  setSelectedPlaylist(playlist.id);
                  setRename(playlist.name);
                  setPlaylistName("");
                } catch (error) {
                  if (error instanceof Error) {
                    handleError(error, "Could not create Playlist.");
                  }
                }
              }}
            >
              <label htmlFor="playlist-name">Playlist name</label>
              <input
                id="playlist-name"
                maxLength={100}
                required
                value={playlistName}
                onChange={(event) => setPlaylistName(event.target.value)}
              />
              <button type="submit">Create Playlist</button>
            </form>
            <div className="playlist-list">
              {playlists.map((playlist) => (
                <button
                  type="button"
                  key={playlist.id}
                  aria-pressed={selectedPlaylist === playlist.id}
                  onClick={() => {
                    setSelectedPlaylist(playlist.id);
                    setRename(playlist.name);
                  }}
                >
                  {playlist.name} · {playlist.setCount}
                </button>
              ))}
            </div>
            {selectedPlaylist &&
              playlists.some(
                (playlist) => playlist.id === selectedPlaylist
              ) && (
                <div className="playlist-editor">
                  <form
                    className="inline-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      try {
                        const updated = await client.renamePlaylist(
                          selectedPlaylist,
                          rename.trim()
                        );
                        setPlaylists((current) =>
                          current.map((item) =>
                            item.id === updated.id ? updated : item
                          )
                        );
                      } catch (error) {
                        if (error instanceof Error) {
                          handleError(error, "Could not rename Playlist.");
                        }
                      }
                    }}
                  >
                    <label htmlFor="rename-playlist">
                      Rename{" "}
                      {
                        playlists.find((item) => item.id === selectedPlaylist)
                          ?.name
                      }
                    </label>
                    <input
                      id="rename-playlist"
                      maxLength={100}
                      required
                      value={rename}
                      onChange={(event) => setRename(event.target.value)}
                    />
                    <button type="submit">Save playlist name</button>
                  </form>
                  <ul>
                    {members.map((set, index) => (
                      <li key={set.id}>
                        {set.title}{" "}
                        <button
                          type="button"
                          aria-label={`Move ${set.title} up`}
                          disabled={index === 0}
                          onClick={() => moveMember(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${set.title} down`}
                          disabled={index === members.length - 1}
                          onClick={() => moveMember(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${set.title} from playlist`}
                          onClick={() =>
                            changeMembers(
                              members.filter((member) => member.id !== set.id)
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const response =
                          await client.playPlaylist(selectedPlaylist);
                        setQueue(response.queue);
                        const active = response.queue.entries.find(
                          (set) => set.id === response.queue.activeSetId
                        );
                        if (active) {
                          const grant = await client.grant(active.id);
                          setPlaying({
                            attempt: (playing?.attempt ?? 0) + 1,
                            set: active,
                            src: streamUrl(active.id, grant.url),
                          });
                        } else {
                          setPlaying(null);
                        }
                      } catch (error) {
                        if (error instanceof Error) {
                          handleError(error, "Could not play Playlist.");
                        }
                      }
                    }}
                  >
                    Play{" "}
                    {
                      playlists.find((item) => item.id === selectedPlaylist)
                        ?.name
                    }
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await client.deletePlaylist(selectedPlaylist);
                        setPlaylists((current) =>
                          current.filter((item) => item.id !== selectedPlaylist)
                        );
                        setSelectedPlaylist(null);
                      } catch (error) {
                        if (error instanceof Error) {
                          handleError(error, "Could not delete Playlist.");
                        }
                      }
                    }}
                  >
                    Delete{" "}
                    {
                      playlists.find((item) => item.id === selectedPlaylist)
                        ?.name
                    }
                  </button>
                </div>
              )}
          </section>
          <section className="workspace-panel" aria-label="Listening queue">
            <h2 id="queue-heading">Listening Queue</h2>
            {reconnecting && <p role="status">Reconnecting to live updates…</p>}
            {queue?.entries.length === 0 && <p>Your queue is empty.</p>}
            <p>
              {queue?.activeSetId
                ? `Playing ${queue.entries.find((set) => set.id === queue.activeSetId)?.title ?? "Set"}`
                : "Nothing playing"}
            </p>
            <ol>
              {queue?.entries
                .filter((set) => set.id !== queue.activeSetId)
                .map((set) => (
                  <li key={set.id}>{set.title}</li>
                ))}
            </ol>
          </section>
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
        <section className="social-panel" aria-label="People">
          <label className="social-switch">
            <input
              type="checkbox"
              checked={social}
              disabled={loading}
              onChange={(event) => {
                changeSocial(event.target.checked);
              }}
            />
            Social
          </label>
          {social && (
            <div>
              <h2>People</h2>
              {people.length === 0 ? (
                <p>No visible People yet.</p>
              ) : (
                <ul className="people-list">
                  {people.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        onClick={() => {
                          openFriend(person);
                        }}
                      >
                        Open {person.username}'s Library
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {friend && (
            <div>
              <h2>{friend.username}'s profile</h2>
              <h2>{friend.username}'s Library</h2>
              <ul className="friend-list">
                {friend.sets.map((set) => (
                  <li key={set.id}>
                    <h3>{set.title}</h3>
                    <p>{set.creator ?? "Unknown creator"}</p>
                  </li>
                ))}
              </ul>
              <h2>Playlists</h2>
              {friend.playlists.length === 0 ? (
                <p>No Playlists yet.</p>
              ) : (
                friend.playlists.map((playlist) => (
                  <section key={playlist.id} aria-label={playlist.name}>
                    <h3>{playlist.name}</h3>
                    <ol>
                      {playlist.sets.map((set) => (
                        <li key={set.id}>{set.title}</li>
                      ))}
                    </ol>
                  </section>
                ))
              )}
              <h2>Listen History</h2>
              {friend.listens.length === 0 ? (
                <p>No Listens yet.</p>
              ) : (
                <ol className="friend-list">
                  {friend.listens.map((listen, index) => (
                    <li key={`${listen.startedAt}-${listen.set.id}-${index}`}>
                      <span>
                        {listen.finishedAt ? "Finished" : "Listened to"}{" "}
                        {listen.set.title}
                      </span>
                      <time dateTime={listen.startedAt}>
                        {new Date(listen.startedAt).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </section>
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
                {set.downloadState !== "ready" && (
                  <div className="download-status">
                    {(audioStates[set.id]?.state ?? set.downloadState) ===
                      "downloading" && (
                      <p role="status">
                        Download{" "}
                        {(() => {
                          const progress = audioStates[set.id];
                          return progress?.bytesTotal
                            ? `${Math.round((progress.bytesReceived / progress.bytesTotal) * 100)}%`
                            : "in progress";
                        })()}
                      </p>
                    )}
                    {(set.downloadState === "none" ||
                      set.downloadState === "failed" ||
                      set.downloadState === "canceled") && (
                      <button type="button" onClick={() => download(set)}>
                        Download {set.title}
                      </button>
                    )}
                  </div>
                )}
                {set.downloadState === "ready" && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const response = await client.queueInsert(
                          set.id,
                          "end"
                        );
                        setQueue(response.queue);
                      } catch (error) {
                        if (error instanceof Error) {
                          handleError(error, "Could not add Set to queue.");
                        }
                      }
                    }}
                  >
                    Add {set.title} to queue
                  </button>
                )}
                {selectedPlaylist &&
                  !members.some((member) => member.id === set.id) && (
                    <button
                      type="button"
                      onClick={() => changeMembers([...members, set])}
                    >
                      Add {set.title} to{" "}
                      {
                        playlists.find((item) => item.id === selectedPlaylist)
                          ?.name
                      }
                    </button>
                  )}
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
          {playerError && (
            <div className="player-notice">
              <p role="alert">{playerError}</p>
              <button
                type="button"
                onClick={() => {
                  retryAudio();
                }}
                disabled={retryingAudio}
              >
                {retryingAudio ? "Trying…" : "Retry audio"}
              </button>
            </div>
          )}
          <audio
            key={playing.attempt}
            controls
            autoPlay
            src={playing.src}
            onError={() => setPlayerError("Audio could not load. Try again.")}
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
                const response = await client.complete(playing.set.id);
                setQueue(response.queue);
                const next = response.queue.entries.find(
                  (set) => set.id === response.queue.activeSetId
                );
                if (next) {
                  const grant = await client.grant(next.id);
                  setPlaying({
                    attempt: playing.attempt + 1,
                    set: next,
                    src: streamUrl(next.id, grant.url),
                  });
                } else {
                  setPlaying(null);
                }
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
