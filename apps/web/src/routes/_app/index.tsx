import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { SetRow } from "@/components/library/set-row";
import { useDownloadProgress } from "@/components/library/use-download-progress";
import { RouteProblem } from "@/components/route-problem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { listSets, listTags, saveSet, setAutoDownload } from "@/lib/library";
import type {
  AutoDownloadResult,
  LibraryFilters,
  SavedSet,
} from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";
import { listPlaylists } from "@/lib/playlists";
import type { Playlist } from "@/lib/playlists";
import type { Session } from "@/routes/_app";

const LibrarySearch = Schema.Struct({
  q: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literals(["youtube", "soundcloud"])),
  tag: Schema.optionalKey(Schema.String),
});

const SEARCH_DELAY_MS = 250;

/** What saving says when Auto Download could not start the Download. */
const saveNotice = (result: AutoDownloadResult): string | null => {
  switch (result) {
    case "queueFull": {
      return "Saved. The Download queue is full; start the Download later.";
    }
    case "unavailable": {
      return "Saved. Downloads are unavailable right now.";
    }
    default: {
      return null;
    }
  }
};

const SaveSetForm = ({
  credentials,
}: {
  readonly credentials: Credentials;
}) => {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const url = String(new FormData(form).get("url") ?? "").trim();
    if (url === "") {
      setMessage("Paste a YouTube or SoundCloud link.");
      return;
    }
    setPending(true);
    const saved = await saveSet(credentials, url);
    setPending(false);
    if (!saved.ok) {
      setMessage(
        saved.failure === "conflict"
          ? "This Set is already in your Library."
          : FAILURE_MESSAGES[saved.failure]
      );
      return;
    }
    form.reset();
    setMessage(saveNotice(saved.value.autoDownloadResult));
    await router.invalidate();
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={save}>
      <Label htmlFor="source-link">Source Link</Label>
      <div className="flex gap-2">
        <Input
          autoComplete="off"
          id="source-link"
          name="url"
          placeholder="https://www.youtube.com/watch?v=…"
          type="url"
        />
        <Button disabled={pending} type="submit">
          Save
        </Button>
      </div>
      {message === null ? null : (
        <p className="text-muted-foreground text-sm" role="status">
          {message}
        </p>
      )}
    </form>
  );
};

const Filters = ({
  filters,
  tags,
}: {
  readonly filters: LibraryFilters;
  readonly tags: readonly string[];
}) => {
  const navigate = useNavigate({ from: "/" });
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = (next: LibraryFilters) =>
    navigate({ replace: true, search: next });
  const search = (event: ChangeEvent<HTMLInputElement>) => {
    const q = event.target.value.trim();
    if (typing.current !== null) {
      clearTimeout(typing.current);
    }
    typing.current = setTimeout(() => {
      const { q: _previous, ...rest } = filters;
      void update(q === "" ? rest : { ...rest, q });
    }, SEARCH_DELAY_MS);
  };
  const choose =
    (name: "source" | "tag") => (event: ChangeEvent<HTMLSelectElement>) => {
      const { [name]: _previous, ...rest } = filters;
      const { value } = event.target;
      void update(value === "" ? rest : { ...rest, [name]: value });
    };
  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
      <div className="flex flex-col gap-2">
        <Label htmlFor="library-search">Search library</Label>
        <Input
          defaultValue={filters.q ?? ""}
          id="library-search"
          onChange={search}
          placeholder="Title, creator, or link"
          type="search"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="library-source">Source</Label>
        <NativeSelect
          id="library-source"
          onChange={choose("source")}
          value={filters.source ?? ""}
        >
          <NativeSelectOption value="">All sources</NativeSelectOption>
          <NativeSelectOption value="youtube">YouTube</NativeSelectOption>
          <NativeSelectOption value="soundcloud">SoundCloud</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="library-tag">Tag</Label>
        <NativeSelect
          id="library-tag"
          onChange={choose("tag")}
          value={filters.tag ?? ""}
        >
          <NativeSelectOption value="">All tags</NativeSelectOption>
          {tags.map((tag) => (
            <NativeSelectOption key={tag} value={tag}>
              {tag}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
};

const AutoDownloadSwitch = ({ session }: { readonly session: Session }) => {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const change = async (autoDownload: boolean) => {
    setPending(true);
    const result = await setAutoDownload(session, autoDownload);
    if (result.ok) {
      setProblem(null);
      await router.invalidate();
    } else {
      setProblem(FAILURE_MESSAGES[result.failure]);
    }
    setPending(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Switch
          aria-label="Auto Download"
          checked={session.person.autoDownload}
          disabled={pending}
          onCheckedChange={change}
        />
        <span aria-hidden>Auto Download</span>
      </div>
      <p className="text-muted-foreground text-sm">
        Keep audio automatically when you save a Set.
      </p>
      {problem === null ? null : <p role="alert">{problem}</p>}
    </div>
  );
};

const Library = ({
  credentials,
  filters,
  playlists,
  sets,
  tags,
}: {
  readonly credentials: Session;
  readonly filters: LibraryFilters;
  readonly playlists: readonly Playlist[];
  readonly sets: readonly SavedSet[];
  readonly tags: readonly string[];
}) => {
  const progress = useDownloadProgress(credentials, sets);
  const filtered = Object.keys(filters).length > 0;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">Library</h1>
      <AutoDownloadSwitch session={credentials} />
      <SaveSetForm credentials={credentials} />
      <Filters filters={filters} tags={tags} />
      <p className="text-muted-foreground text-sm" role="status">
        {sets.length} {sets.length === 1 ? "Set" : "Sets"}
      </p>
      {sets.length === 0 ? (
        <p className="text-muted-foreground">
          {filtered
            ? "No Sets match these filters."
            : "Save a Source Link to start your Library."}
        </p>
      ) : (
        <ul aria-label="Sets">
          {sets.map((set) => (
            <SetRow
              credentials={credentials}
              key={set.id}
              playlists={playlists}
              progress={progress.get(set.id)}
              set={set}
            />
          ))}
        </ul>
      )}
    </main>
  );
};

export const Route = createFileRoute("/_app/")({
  // The route hands its own data down, which keeps the types exact.
  component: () => {
    const { session } = Route.useRouteContext();
    const { playlists, sets, tags } = Route.useLoaderData();
    return (
      <Library
        credentials={session}
        filters={Route.useSearch()}
        playlists={playlists}
        sets={sets}
        tags={tags}
      />
    );
  },
  errorComponent: RouteProblem,
  loader: async ({ context, deps }) => {
    const [sets, tags, playlists] = await Promise.all([
      listSets(context.session, deps),
      listTags(context.session),
      listPlaylists(context.session),
    ]);
    if (!sets.ok) {
      throw new Error(FAILURE_MESSAGES[sets.failure]);
    }
    return {
      playlists: playlists.ok ? playlists.value.playlists : [],
      sets: sets.value.sets,
      tags: tags.ok ? tags.value.tags : [],
    };
  },
  loaderDeps: ({ search }) => search,
  validateSearch: Schema.toStandardSchemaV1(LibrarySearch),
});
