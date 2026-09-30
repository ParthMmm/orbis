import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { useLiveEvents } from "@/components/live-events";
import { usePlayer } from "@/components/player/player";
import { Button } from "@/components/ui/button";
import { FAILURE_MESSAGES } from "@/lib/orbis";

const Queue = () => {
  const { queue, reconnecting } = useLiveEvents();
  const player = usePlayer();
  const [problem, setProblem] = useState<string | null>(null);
  const active = queue?.entries.find((set) => set.id === queue.activeSetId);
  const upcoming =
    queue?.entries.filter((set) => set.id !== queue.activeSetId) ?? [];
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">Listening Queue</h1>
      {reconnecting ? (
        <p className="text-muted-foreground text-sm" role="status">
          Reconnecting…
        </p>
      ) : null}
      <section aria-label="Listening queue" className="flex flex-col gap-4">
        {queue === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p>
              {active === undefined
                ? "Nothing playing"
                : `Now: ${active.title}`}
            </p>
            {queue.entries.length === 0 ? (
              <p className="text-muted-foreground">Your queue is empty.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {upcoming.map((set) => (
                  <li className="flex items-center gap-4" key={set.id}>
                    <span className="flex-1 truncate">{set.title}</span>
                    <Button
                      aria-label={`Play ${set.title}`}
                      onClick={async () => {
                        const played = await player.play(set);
                        setProblem(
                          played.ok ? null : FAILURE_MESSAGES[played.failure]
                        );
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Play
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>
      {problem === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      )}
    </main>
  );
};

export const Route = createFileRoute("/_app/queue")({ component: Queue });
