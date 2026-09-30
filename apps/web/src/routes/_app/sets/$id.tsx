import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Tracklist } from "@/components/library/tracklist";
import { useDownloadProgress } from "@/components/library/use-download-progress";
import { usePlayer } from "@/components/player/player";
import { RouteProblem } from "@/components/route-problem";
import { Button } from "@/components/ui/button";
import { listSets, requestDownload } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import { getTracklist, retryTracklist } from "@/lib/tracklists";
import type { Session } from "@/routes/_app";

const AudioAction = ({
  download,
  play,
  progress,
  set,
}: {
  readonly download: () => Promise<void>;
  readonly play: (seconds: number) => Promise<void>;
  readonly progress: number | undefined;
  readonly set: SavedSet;
}) => {
  if (set.downloadState === "ready") {
    return (
      <Button onClick={() => play(set.playbackPositionSeconds)}>Play</Button>
    );
  }
  if (set.downloadState === "queued" || set.downloadState === "downloading") {
    return (
      <p className="text-muted-foreground text-sm">
        {progress === undefined
          ? "Keeping audio…"
          : `Keeping audio ${Math.round(progress * 100)}%`}
      </p>
    );
  }
  return (
    <Button onClick={download} variant="outline">
      Keep audio to play
    </Button>
  );
};

const SetPage = ({
  session,
  set,
  tracklist,
}: {
  readonly session: Session;
  readonly set: SavedSet | null;
  readonly tracklist: Awaited<ReturnType<typeof getTracklist>> | null;
}) => {
  const router = useRouter();
  const player = usePlayer();
  const [problem, setProblem] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const downloadProgress = useDownloadProgress(
    session,
    set === null ? [] : [set]
  );
  const tracklistState = tracklist?.ok === true ? tracklist.value.state : null;

  useEffect(() => {
    if (tracklistState !== "pending") {
      return;
    }
    const timer = setInterval(() => {
      router.invalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [router, tracklistState]);

  if (set === null) {
    return (
      <main className="mx-auto w-full max-w-3xl p-6">
        <h1 className="text-2xl font-medium">Set not found</h1>
        <Link className="text-primary underline" to="/">
          Back to Library
        </Link>
      </main>
    );
  }

  const play = async (seconds: number) => {
    if (set.downloadState !== "ready") {
      setProblem("Keep audio to play this Set.");
      return;
    }
    const result = await player.playFrom(set, seconds);
    setProblem(result.ok ? null : FAILURE_MESSAGES[result.failure]);
  };
  const download = async () => {
    const result = await requestDownload(session, set.id);
    setProblem(result.ok ? null : FAILURE_MESSAGES[result.failure]);
    if (result.ok) {
      await router.invalidate();
    }
  };
  const retry = async () => {
    setRetrying(true);
    const result = await retryTracklist(session, set.id);
    setRetrying(false);
    setProblem(result.ok ? null : FAILURE_MESSAGES[result.failure]);
    if (result.ok) {
      await router.invalidate();
    }
  };

  let tracklistContent = null;
  if (tracklist?.ok === false) {
    tracklistContent = (
      <p role="alert">{FAILURE_MESSAGES[tracklist.failure]}</p>
    );
  } else if (tracklist?.ok === true) {
    tracklistContent = (
      <Tracklist
        cues={tracklist.value.cues}
        currentSeconds={
          player.playing?.set.id === set.id ? player.elapsed : null
        }
        onRetry={() => {
          retry();
        }}
        onSeek={(seconds) => {
          play(seconds);
        }}
        retrying={retrying}
        state={tracklist.value.state}
      />
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <Link className="text-muted-foreground w-fit text-sm underline" to="/">
        Library
      </Link>
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end">
        {(set.artworkLargeUrl ?? set.artworkUrl) ? (
          <img
            alt=""
            className="aspect-square w-40 shrink-0 rounded-md object-cover sm:w-48"
            src={set.artworkLargeUrl ?? set.artworkUrl ?? ""}
          />
        ) : (
          <div
            aria-hidden
            className="bg-muted aspect-square w-40 shrink-0 rounded-md sm:w-48"
          />
        )}
        <div className="flex min-w-0 flex-col items-start gap-3">
          <div>
            <h1 className="text-2xl font-medium text-pretty">{set.title}</h1>
            <p className="text-muted-foreground">
              {set.creator ?? "Unknown creator"}
            </p>
          </div>
          <AudioAction
            download={download}
            play={play}
            progress={downloadProgress.get(set.id)}
            set={set}
          />
        </div>
      </header>
      {problem === null ? null : <p role="alert">{problem}</p>}
      {tracklistContent}
      {retrying ? <p role="status">Retrying Tracklist…</p> : null}
    </main>
  );
};

export const Route = createFileRoute("/_app/sets/$id")({
  component: () => (
    <SetPage
      session={Route.useRouteContext().session}
      set={Route.useLoaderData().set}
      tracklist={Route.useLoaderData().tracklist}
    />
  ),
  errorComponent: RouteProblem,
  loader: async ({ context, params }) => {
    const sets = await listSets(context.session, {});
    if (!sets.ok) {
      throw new Error(FAILURE_MESSAGES[sets.failure]);
    }
    const set = sets.value.sets.find((saved) => saved.id === params.id) ?? null;
    return {
      set,
      tracklist:
        set === null ? null : await getTracklist(context.session, set.id),
    };
  },
});
