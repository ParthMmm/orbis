import type { LibraryFilters, SavedSet, SetSource } from "@orbis/contracts";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Playlists } from "./playlists";
import { TagInput } from "./tag-input";
import "./api";

const sourceNames = { soundcloud: "SoundCloud", youtube: "YouTube" };

const TagEditor = ({
  set,
  suggestions,
  onCancel,
  onSaved,
}: {
  set: SavedSet;
  suggestions: string[];
  onCancel: () => void;
  onSaved: () => void;
}) => {
  const [tags, setTags] = useState(set.tags);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await window.orbis.updateTags(set.id, tags);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSaved();
  };
  return (
    <form onSubmit={submit} aria-label={`Edit tags for ${set.title}`}>
      <fieldset disabled={busy}>
        <TagInput tags={tags} onChange={setTags} suggestions={suggestions} />
        <div className="input-row">
          <button type="submit">{busy ? "Saving…" : "Save tags"}</button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
};

const SetCard = ({
  set,
  suggestions,
  onUpdated,
}: {
  set: SavedSet;
  suggestions: string[];
  onUpdated: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const openSource = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const result = await window.orbis.openSource(set.url);
    setError(result.ok ? "" : result.message);
  };
  return (
    <li className="set-card">
      <div className="set-heading">
        <span className="source">{sourceNames[set.source]}</span>
        <time dateTime={set.createdAt}>
          {new Date(set.createdAt).toLocaleDateString()}
        </time>
      </div>
      <h3>
        <a href={set.url} onClick={openSource}>
          {set.title}
        </a>
      </h3>
      <p className="source-url">{set.url}</p>
      {editing ? (
        <TagEditor
          set={set}
          suggestions={suggestions}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onUpdated();
          }}
        />
      ) : (
        <>
          <div className="card-bottom">
            <ul className="tag-list">
              {set.tags.map((tag) => (
                <li key={tag}>
                  <span className="tag">{tag}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label={`Edit tags for ${set.title}`}
            >
              Edit tags
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </li>
  );
};

export const App = () => {
  const [sets, setSets] = useState<SavedSet[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [playlistId, setPlaylistId] = useState("");
  const [q, setQ] = useState("");
  const [source, setSource] = useState<SetSource | "">("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tagError, setTagError] = useState("");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const reload = () => setRevision((value) => value + 1);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    const load = async () => {
      const filters: LibraryFilters = { playlistId, q, tags: selectedTags };
      if (source) {
        filters.source = source;
      }
      const result = await window.orbis.list(filters);
      if (!active) {
        return;
      }
      setLoading(false);
      if (result.ok) {
        setSets(result.data.sets);
      } else {
        setLoadError(result.message);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [playlistId, q, source, selectedTags, revision]);

  useEffect(() => {
    let active = true;
    const loadTags = async () => {
      const result = await window.orbis.tags();
      if (!active) {
        return;
      }
      setTagError(result.ok ? "" : result.message);
      if (result.ok) {
        setSuggestions(result.data.tags);
      }
    };
    void loadTags();
    return () => {
      active = false;
    };
  }, [revision]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    setNotice("");
    const result = await window.orbis.save({ tags, title, url });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setUrl("");
    setTitle("");
    setTags([]);
    setPlaylistId("");
    setQ("");
    setSource("");
    setSelectedTags([]);
    setNotice(`Saved ${result.data.title}.`);
    reload();
  };
  const filtering = Boolean(q || source || selectedTags.length);
  let resultCount = `${sets.length} ${sets.length === 1 ? "set" : "sets"}`;
  if (loading) {
    resultCount = "Loading library…";
  } else if (loadError) {
    resultCount = "Library unavailable";
  }
  let emptyTitle = "Start your collection";
  let emptyMessage =
    "Save your first YouTube or SoundCloud set using the form.";
  if (filtering) {
    emptyTitle = "No matching sets";
    emptyMessage = "Try another search or clear your filters.";
  } else if (playlistId) {
    emptyTitle = "This playlist is empty";
    emptyMessage = "Add saved sets using Manage playlist.";
  }
  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">YOUR MUSIC, IN ONE PLACE</p>
          <h1>Orbis</h1>
        </div>
        <span className="local-badge">Local library</span>
      </header>
      <div className="workspace">
        <div className="sidebar">
          <section className="save-panel" aria-labelledby="save-heading">
            <h2 id="save-heading">Save a set</h2>
            <p className="muted">
              Keep the link. Find it when the mood is right.
            </p>
            <form onSubmit={save}>
              <fieldset disabled={saving}>
                <label htmlFor="set-url">YouTube or SoundCloud URL</label>
                <input
                  id="set-url"
                  type="url"
                  required
                  maxLength={2048}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://…"
                />
                <label htmlFor="set-title">Title</label>
                <input
                  id="set-title"
                  required
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Artist — live at…"
                />
                <TagInput
                  tags={tags}
                  onChange={setTags}
                  suggestions={suggestions}
                />
                <button type="submit" className="primary">
                  {saving ? "Saving…" : "Save set"}
                </button>
              </fieldset>
              {saveError && (
                <p role="alert" className="error">
                  {saveError}
                </p>
              )}
            </form>
            <p role="status" className="notice">
              {notice}
            </p>
            <p className="hint">
              Links only for now. Open a title to listen on its original
              platform.
            </p>
          </section>
          <Playlists
            selected={playlistId}
            onSelect={setPlaylistId}
            revision={revision}
            onUpdated={reload}
          />
        </div>
        <section className="library" aria-labelledby="library-heading">
          <div className="library-heading">
            <h2 id="library-heading">Your library</h2>
            <button type="button" onClick={reload}>
              Refresh
            </button>
          </div>
          <div className="filters">
            <div>
              <label htmlFor="search">Search</label>
              <input
                id="search"
                type="search"
                maxLength={200}
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="Search titles or links"
              />
            </div>
            <div>
              <label htmlFor="source">Source</label>
              <select
                id="source"
                value={source}
                onChange={(event) => {
                  const { value } = event.target;
                  if (
                    value === "" ||
                    value === "youtube" ||
                    value === "soundcloud"
                  ) {
                    setSource(value);
                  }
                }}
              >
                <option value="">All sources</option>
                <option value="youtube">YouTube</option>
                <option value="soundcloud">SoundCloud</option>
              </select>
            </div>
          </div>
          {suggestions.length + selectedTags.length > 0 && (
            <fieldset className="tag-filters">
              <legend>Match all selected tags</legend>
              <div className="tag-list">
                {[...new Set([...suggestions, ...selectedTags])].map((tag) => (
                  <label className="tag-filter" key={tag}>
                    <input
                      type="checkbox"
                      checked={selectedTags.includes(tag)}
                      onChange={(event) =>
                        setSelectedTags(
                          event.target.checked
                            ? [...selectedTags, tag]
                            : selectedTags.filter((value) => value !== tag)
                        )
                      }
                    />
                    {tag}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {filtering && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                setSource("");
                setSelectedTags([]);
              }}
            >
              Clear filters
            </button>
          )}
          {tagError && !loadError && (
            <p role="alert" className="error">
              Tags could not load.{" "}
              <button type="button" onClick={reload}>
                Retry
              </button>
            </p>
          )}
          <p role="status" className="result-count">
            {resultCount}
          </p>
          {loadError ? (
            <div role="alert" className="empty">
              <p>{loadError}</p>
              <button type="button" onClick={reload}>
                Retry
              </button>
            </div>
          ) : (
            !loading &&
            (sets.length ? (
              <ul className="sets">
                {sets.map((set) => (
                  <SetCard
                    key={set.id}
                    set={set}
                    suggestions={suggestions}
                    onUpdated={() => {
                      setNotice("Tags saved.");
                      reload();
                    }}
                  />
                ))}
              </ul>
            ) : (
              <div className="empty">
                <h3>{emptyTitle}</h3>
                <p>{emptyMessage}</p>
              </div>
            ))
          )}
        </section>
      </div>
    </main>
  );
};
