import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { DownloadBadge, setDetails } from "@/components/library/set-row";
import { useDownloadProgress } from "@/components/library/use-download-progress";
import { useLiveEvents } from "@/components/live-events";
import { usePlayer } from "@/components/player/player";
import { RouteProblem } from "@/components/route-problem";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { listSets, requestDownload, saveSet } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import {
  friendListens,
  friendPlaylists,
  friendSets,
  listVisiblePeople,
} from "@/lib/people";
import type { FriendPlaylist, Listen } from "@/lib/people";

const RECENT_SETS = 3;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface Profile {
  readonly id: string;
  readonly listens: readonly Listen[];
  /** The ids of the Sets in the viewer's own Library. */
  readonly mine: readonly string[];
  readonly playlists: readonly FriendPlaylist[];
  readonly sets: readonly SavedSet[];
  readonly username: string;
}

/** Why saving or downloading a friend's Set did not do what the Person asked. */
const actionProblem = (result: ApiResult<unknown>): string | null => {
  if (result.ok) {
    return null;
  }
  if (result.failure === "limited") {
    return "The Download queue is full. Try again later.";
  }
  return FAILURE_MESSAGES[result.failure];
};

const FriendSetRow = ({
  credentials,
  progress,
  saved,
  set,
}: {
  readonly credentials: Credentials;
  readonly progress: number | undefined;
  readonly saved: boolean;
  readonly set: SavedSet;
}) => {
  const router = useRouter();
  const player = usePlayer();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const act = async (run: () => Promise<ApiResult<unknown>>) => {
    setPending(true);
    const result = await run();
    setPending(false);
    // Saving a Set already in the Library is a conflict, and the result is the same.
    const settled =
      result.ok || result.failure === "conflict" ? null : actionProblem(result);
    setProblem(settled);
    if (settled === null) {
      await router.invalidate();
    }
  };
  const downloadable = ["none", "failed", "canceled"].includes(
    set.downloadState
  );
  return (
    <li className="flex items-start gap-4 py-4">
      {set.artworkUrl === null ? (
        <div className="bg-muted size-16 shrink-0 rounded-md" />
      ) : (
        <img
          alt=""
          className="size-16 shrink-0 rounded-md object-cover"
          src={set.artworkUrl}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="truncate font-medium">{set.title}</h3>
        <p className="text-muted-foreground text-sm">{setDetails(set)}</p>
        <div className="flex flex-wrap gap-1">
          <DownloadBadge progress={progress} set={set} />
        </div>
        {problem === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {set.downloadState === "ready" ? (
          <Button
            aria-label={`Play ${set.title}`}
            disabled={pending}
            onClick={() => act(() => player.play(set))}
            size="sm"
            variant="outline"
          >
            Play
          </Button>
        ) : null}
        {downloadable ? (
          <Button
            aria-label={`Download ${set.title}`}
            disabled={pending}
            onClick={() => act(() => requestDownload(credentials, set.id))}
            size="sm"
            variant="outline"
          >
            Download
          </Button>
        ) : null}
        {saved ? (
          <Button disabled size="sm" variant="secondary">
            Saved
          </Button>
        ) : (
          <Button
            aria-label={`Save ${set.title}`}
            disabled={pending}
            onClick={() => act(() => saveSet(credentials, set.url))}
            size="sm"
          >
            Save
          </Button>
        )}
      </div>
    </li>
  );
};

const Section = ({
  children,
  description,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly title: string;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2 className="text-lg">{title}</h2>
      </CardTitle>
      {description === undefined ? null : (
        <CardDescription>{description}</CardDescription>
      )}
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const Empty = ({ children }: { readonly children: string }) => (
  <p className="text-muted-foreground text-sm">{children}</p>
);

const FriendProfile = ({
  credentials,
  profile,
}: {
  readonly credentials: Credentials;
  readonly profile: Profile;
}) => {
  const { presence } = useLiveEvents();
  const progress = useDownloadProgress(credentials, profile.sets);
  const listening = presence.find((entry) => entry.personId === profile.id);
  const recent = [
    ...new Map(
      profile.listens.map((listen) => [listen.set.id, listen.set])
    ).values(),
  ].slice(0, RECENT_SETS);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">{profile.username}</h1>
        <p className="text-muted-foreground text-sm" role="status">
          {listening === undefined
            ? "Not listening right now"
            : `${profile.username} is listening to ${listening.set.title}`}
        </p>
      </div>
      <Section
        description="Save a Set to add it to your own Library."
        title={`${profile.username}’s Library`}
      >
        {profile.sets.length === 0 ? (
          <Empty>No Sets yet.</Empty>
        ) : (
          <ul aria-label={`${profile.username}’s Sets`} className="divide-y">
            {profile.sets.map((set) => (
              <FriendSetRow
                credentials={credentials}
                key={set.id}
                progress={progress.get(set.id)}
                saved={profile.mine.includes(set.id)}
                set={set}
              />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Playlists">
        {profile.playlists.length === 0 ? (
          <Empty>No Playlists yet.</Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {profile.playlists.map((playlist) => (
              <section aria-label={playlist.name} key={playlist.id}>
                <h3 className="font-medium">{playlist.name}</h3>
                <ol className="text-muted-foreground list-decimal pl-5 text-sm">
                  {playlist.sets.map((set) => (
                    <li key={set.id}>{set.title}</li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Section>
      <Section title="Recent Sets">
        {recent.length === 0 ? (
          <Empty>No recent Sets.</Empty>
        ) : (
          <ul aria-label="Recent Sets" className="flex flex-col gap-1 text-sm">
            {recent.map((set) => (
              <li key={set.id}>{set.title}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Listen History">
        {profile.listens.length === 0 ? (
          <Empty>No Listens yet.</Empty>
        ) : (
          <ol aria-label="Listen History" className="divide-y text-sm">
            {profile.listens.map((listen) => (
              <li
                className="flex justify-between gap-4 py-2"
                key={`${listen.startedAt}-${listen.set.id}`}
              >
                <span>
                  {listen.finishedAt === null ? "Listened to" : "Finished"}{" "}
                  {listen.set.title}
                </span>
                <time
                  className="text-muted-foreground shrink-0"
                  dateTime={listen.startedAt}
                >
                  {timeFormat.format(new Date(listen.startedAt))}
                </time>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </main>
  );
};

/** The API answers 404 for a Person the caller cannot see, whatever the reason. */
const NotVisible = () => (
  <main className="mx-auto w-full max-w-md p-6">
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-2xl">Not visible</h1>
        </CardTitle>
        <CardDescription>
          This Person’s Library is not visible to you. One of you may have
          turned Social off, or changed See or Appear.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link className={buttonVariants({ variant: "outline" })} to="/people">
          Back to People
        </Link>
      </CardContent>
    </Card>
  </main>
);

export const Route = createFileRoute("/_app/people/$id")({
  component: () => {
    const profile = Route.useLoaderData();
    const { session } = Route.useRouteContext();
    return profile === null ? (
      <NotVisible />
    ) : (
      <FriendProfile credentials={session} profile={profile} />
    );
  },
  errorComponent: RouteProblem,
  loader: async ({ context, params }): Promise<Profile | null> => {
    const { session } = context;
    const { id } = params;
    const [people, sets, playlists, listens, mine] = await Promise.all([
      listVisiblePeople(session),
      friendSets(session, id),
      friendPlaylists(session, id),
      friendListens(session, id),
      listSets(session, {}),
    ]);
    const results = [people, sets, playlists, listens, mine];
    if (results.some((result) => !result.ok && result.status === 404)) {
      return null;
    }
    if (!people.ok || !sets.ok || !playlists.ok || !listens.ok || !mine.ok) {
      const failed = results.find((result) => !result.ok);
      throw new Error(
        FAILURE_MESSAGES[failed?.ok === false ? failed.failure : "failed"]
      );
    }
    const person = people.value.people.find((item) => item.id === id);
    if (person === undefined) {
      return null;
    }
    return {
      id,
      listens: listens.value.listens,
      mine: mine.value.sets.map((set) => set.id),
      playlists: playlists.value.playlists,
      sets: sets.value.sets,
      username: person.username,
    };
  },
});
