import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { RouteProblem } from "@/components/route-problem";
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
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";
import {
  createPlaylist,
  listPlaylists,
  listSharedPlaylists,
} from "@/lib/playlists";
import type { Playlist, SharedPlaylist } from "@/lib/playlists";

const setCount = (count: number) => `${count} ${count === 1 ? "Set" : "Sets"}`;

const CreatePlaylistForm = ({
  credentials,
}: {
  readonly credentials: Credentials;
}) => {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(
      new FormData(event.currentTarget).get("name") ?? ""
    ).trim();
    if (name === "") {
      setProblem("Enter a Playlist name.");
      return;
    }
    setPending(true);
    const created = await createPlaylist(credentials, name);
    setPending(false);
    if (!created.ok) {
      setProblem(
        created.failure === "conflict"
          ? "You already have a Playlist with this name."
          : FAILURE_MESSAGES[created.failure]
      );
      return;
    }
    await navigate({
      params: { id: created.value.id },
      to: "/playlists/$id",
    });
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={create}>
      <Label htmlFor="playlist-name">Playlist name</Label>
      <div className="flex gap-2">
        <Input
          autoComplete="off"
          id="playlist-name"
          maxLength={100}
          name="name"
        />
        <Button disabled={pending} type="submit">
          Create Playlist
        </Button>
      </div>
      {problem === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
};

const PlaylistLink = ({
  detail,
  playlist,
}: {
  readonly detail: string;
  readonly playlist: Playlist;
}) => (
  <li>
    <Link
      className="hover:bg-muted flex items-baseline justify-between gap-4 rounded-md px-2 py-3"
      params={{ id: playlist.id }}
      to="/playlists/$id"
    >
      <span className="truncate font-medium">{playlist.name}</span>
      <span className="text-muted-foreground shrink-0 text-sm">{detail}</span>
    </Link>
  </li>
);

const Playlists = ({
  credentials,
  owned,
  shared,
}: {
  readonly credentials: Credentials;
  readonly owned: readonly Playlist[];
  readonly shared: readonly SharedPlaylist[];
}) => (
  <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-2xl">Playlists</h1>
        </CardTitle>
        <CardDescription>
          A Playlist is a named, ordered selection of Sets.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <CreatePlaylistForm credentials={credentials} />
        {owned.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You have no Playlists yet.
          </p>
        ) : (
          <ul aria-label="Your Playlists" className="divide-y">
            {owned.map((playlist) => (
              <PlaylistLink
                detail={setCount(playlist.setCount)}
                key={playlist.id}
                playlist={playlist}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
    {shared.length === 0 ? null : (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-lg">Shared with you</h2>
          </CardTitle>
          <CardDescription>
            Collaborative Playlists where you can add, remove, and reorder Sets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul aria-label="Shared with you" className="divide-y">
            {shared.map((playlist) => (
              <PlaylistLink
                detail={`${playlist.creator.username} · ${setCount(playlist.setCount)}`}
                key={playlist.id}
                playlist={playlist}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    )}
  </main>
);

export const Route = createFileRoute("/_app/playlists/")({
  component: () => {
    const { session } = Route.useRouteContext();
    const { owned, shared } = Route.useLoaderData();
    return <Playlists credentials={session} owned={owned} shared={shared} />;
  },
  errorComponent: RouteProblem,
  loader: async ({ context }) => {
    const [owned, shared] = await Promise.all([
      listPlaylists(context.session),
      listSharedPlaylists(context.session),
    ]);
    if (!owned.ok) {
      throw new Error(FAILURE_MESSAGES[owned.failure]);
    }
    if (!shared.ok) {
      throw new Error(FAILURE_MESSAGES[shared.failure]);
    }
    return {
      owned: owned.value.playlists,
      shared: shared.value.playlists,
    };
  },
});
