import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { usePlayer } from "@/components/player/player";
import { CollaborationCard } from "@/components/playlists/collaboration";
import { Members } from "@/components/playlists/members";
import { RouteProblem } from "@/components/route-problem";
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
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listSets } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";
import {
  deletePlaylist,
  listPeople,
  readCollaboration,
  readPlaylist,
  renamePlaylist,
} from "@/lib/playlists";
import type {
  Collaboration,
  PlaylistDetail,
  VisiblePerson,
} from "@/lib/playlists";

const RenameDialog = ({
  credentials,
  playlist,
}: {
  readonly credentials: Credentials;
  readonly playlist: PlaylistDetail;
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(
      new FormData(event.currentTarget).get("name") ?? ""
    ).trim();
    if (name === "") {
      setProblem("Enter a Playlist name.");
      return;
    }
    setPending(true);
    const result = await renamePlaylist(credentials, playlist.id, name);
    setPending(false);
    if (!result.ok) {
      setProblem(
        result.failure === "conflict"
          ? "You already have a Playlist with this name."
          : FAILURE_MESSAGES[result.failure]
      );
      return;
    }
    setProblem(null);
    setOpen(false);
    await router.invalidate();
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button variant="outline" />}>
        Rename…
      </DialogTrigger>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={rename}>
          <DialogHeader>
            <DialogTitle>Rename {playlist.name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rename-playlist">Playlist name</Label>
            <Input
              autoComplete="off"
              defaultValue={playlist.name}
              id="rename-playlist"
              maxLength={100}
              name="name"
            />
          </div>
          {problem === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button disabled={pending} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const DeleteDialog = ({
  credentials,
  playlist,
}: {
  readonly credentials: Credentials;
  readonly playlist: PlaylistDetail;
}) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = async () => {
    setPending(true);
    const result = await deletePlaylist(credentials, playlist.id);
    if (!result.ok) {
      setPending(false);
      setProblem(FAILURE_MESSAGES[result.failure]);
      return;
    }
    await navigate({ to: "/playlists" });
  };
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger render={<Button variant="outline" />}>
        Delete…
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {playlist.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The Playlist goes away for you and its editors. Its Sets stay in
            every Library.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {problem === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={remove}
            variant="destructive"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const PlaylistPage = ({
  collaboration,
  credentials,
  library,
  people,
  playlist,
}: {
  readonly collaboration: Collaboration | null;
  readonly credentials: Credentials;
  readonly library: readonly SavedSet[];
  readonly people: readonly VisiblePerson[];
  readonly playlist: PlaylistDetail;
}) => {
  const player = usePlayer();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const play = async () => {
    setPending(true);
    const result = await player.playPlaylist(playlist.id);
    setPending(false);
    setProblem(result.ok ? null : FAILURE_MESSAGES[result.failure]);
  };
  const creator = playlist.role === "creator";
  const count = `${playlist.sets.length} ${playlist.sets.length === 1 ? "Set" : "Sets"}`;
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <Link className="text-muted-foreground text-sm" to="/playlists">
        ← Playlists
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl">{playlist.name}</h1>
          </CardTitle>
          <CardDescription>
            {creator
              ? count
              : `${count} · Shared by ${playlist.creator.username}. You can add, remove, and reorder Sets.`}
          </CardDescription>
          {creator ? (
            <CardAction className="flex gap-2">
              <RenameDialog credentials={credentials} playlist={playlist} />
              <DeleteDialog credentials={credentials} playlist={playlist} />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button
            disabled={
              pending ||
              !playlist.sets.some((set) => set.downloadState === "ready")
            }
            onClick={play}
          >
            Play Playlist
          </Button>
          {problem === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          )}
          <Members
            credentials={credentials}
            library={library}
            playlist={playlist}
          />
        </CardContent>
      </Card>
      {creator && collaboration !== null ? (
        <CollaborationCard
          collaboration={collaboration}
          credentials={credentials}
          people={people}
          playlistId={playlist.id}
        />
      ) : null}
    </main>
  );
};

export const Route = createFileRoute("/_app/playlists/$id")({
  component: () => {
    const { session } = Route.useRouteContext();
    const data = Route.useLoaderData();
    return <PlaylistPage credentials={session} {...data} />;
  },
  errorComponent: RouteProblem,
  loader: async ({ context, params }) => {
    const { session } = context;
    const playlist = await readPlaylist(session, params.id);
    if (!playlist.ok) {
      throw new Error(
        playlist.status === 404
          ? "This Playlist does not exist, or you cannot open it."
          : FAILURE_MESSAGES[playlist.failure]
      );
    }
    const creator = playlist.value.role === "creator";
    const [library, collaboration, people] = await Promise.all([
      listSets(session, {}),
      creator ? readCollaboration(session, params.id) : null,
      creator ? listPeople(session) : null,
    ]);
    return {
      collaboration: collaboration?.ok ? collaboration.value : null,
      library: library.ok ? library.value.sets : [],
      people: people?.ok ? people.value.people : [],
      playlist: playlist.value,
    };
  },
});
