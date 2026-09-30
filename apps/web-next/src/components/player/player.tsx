import { createContext, use, useRef, useState } from "react";
import type { ReactNode, SyntheticEvent } from "react";

import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerDurationDisplay,
  AudioPlayerElement,
  AudioPlayerMuteButton,
  AudioPlayerPlayButton,
  AudioPlayerSeekBackwardButton,
  AudioPlayerSeekForwardButton,
  AudioPlayerTimeDisplay,
  AudioPlayerTimeRange,
  AudioPlayerVolumeRange,
} from "@/components/ai-elements/audio-player";
import { Button } from "@/components/ui/button";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";
import {
  completeSet,
  playSet,
  queueSet,
  reportPosition,
  streamUrl,
} from "@/lib/player";

// Report the Playback Position this often while playing, plus on pause and seek.
const REPORT_EVERY_MS = 15_000;

interface Playing {
  /** Bumped for each new source, so the `<audio>` element starts fresh. */
  readonly attempt: number;
  readonly set: SavedSet;
  readonly src: string;
}

export interface Player {
  readonly playing: Playing | null;
  /** Makes `set` the active queue entry and plays it from its saved position. */
  readonly play: (set: SavedSet) => Promise<ApiResult<unknown>>;
  readonly queue: (
    set: SavedSet,
    placement: "next" | "end"
  ) => Promise<ApiResult<unknown>>;
}

// Outside the signed-in shell there is no player; nothing plays.
const unavailable = (): Promise<ApiResult<unknown>> =>
  Promise.resolve({ failure: "failed", ok: false, status: undefined });

const PlayerContext = createContext<Player>({
  play: unavailable,
  playing: null,
  queue: unavailable,
});

export const usePlayer = (): Player => use(PlayerContext);

/**
 * Plays one Set at a time from Vanta through stream grants and keeps the
 * Listening Queue moving: when a Set ends it completes it and plays the next.
 */
export const PlayerProvider = ({
  children,
  credentials,
}: {
  readonly children: ReactNode;
  readonly credentials: Credentials;
}) => {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lastReport = useRef(0);

  const start = async (
    set: SavedSet,
    attempt: number
  ): Promise<ApiResult<unknown>> => {
    const src = await streamUrl(credentials, set.id);
    if (!src.ok) {
      setProblem(FAILURE_MESSAGES[src.failure]);
      return src;
    }
    lastReport.current = 0;
    setProblem(null);
    setPlaying({ attempt, set, src: src.value });
    return src;
  };

  const play = async (set: SavedSet): Promise<ApiResult<unknown>> => {
    const played = await playSet(credentials, set.id);
    if (!played.ok) {
      return played;
    }
    const { activeSetId, entries } = played.value.queue;
    const active = entries.find((entry) => entry.id === activeSetId);
    if (!active) {
      setPlaying(null);
      return played;
    }
    return start(active, (playing?.attempt ?? 0) + 1);
  };

  const queue = (set: SavedSet, placement: "next" | "end") =>
    queueSet(credentials, set.id, placement);

  const report = (event: SyntheticEvent<HTMLAudioElement>) => {
    if (playing !== null && Number.isFinite(event.currentTarget.currentTime)) {
      void reportPosition(
        credentials,
        playing.set.id,
        event.currentTarget.currentTime
      );
    }
  };

  const reportNowAndThen = (event: SyntheticEvent<HTMLAudioElement>) => {
    const now = Date.now();
    if (now - lastReport.current >= REPORT_EVERY_MS) {
      lastReport.current = now;
      report(event);
    }
  };

  const finish = async () => {
    if (playing === null) {
      return;
    }
    await reportPosition(credentials, playing.set.id, 0);
    const completed = await completeSet(credentials, playing.set.id);
    if (!completed.ok) {
      setProblem(FAILURE_MESSAGES[completed.failure]);
      return;
    }
    const { activeSetId, entries } = completed.value.queue;
    const next = entries.find((entry) => entry.id === activeSetId);
    if (next) {
      await start(next, playing.attempt + 1);
    } else {
      setPlaying(null);
    }
  };

  const retry = async () => {
    if (playing !== null) {
      await start(playing.set, playing.attempt + 1);
    }
  };

  return (
    <PlayerContext value={{ play, playing, queue }}>
      {/* The page fills the shell, so the player bar rests at the bottom. */}
      <div className="flex flex-1 flex-col">{children}</div>
      {playing === null ? null : (
        <section
          aria-label="Audio player"
          className="bg-background sticky bottom-0 flex flex-wrap items-center gap-4 border-t px-6 py-3"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{playing.set.title}</p>
            <p className="text-muted-foreground truncate text-sm">
              {playing.set.creator ?? "Unknown creator"}
            </p>
          </div>
          <AudioPlayer className="w-full max-w-xl" key={playing.attempt}>
            <AudioPlayerElement
              autoPlay
              onEnded={finish}
              onError={() => setProblem("The audio could not load.")}
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime =
                  playing.set.playbackPositionSeconds;
              }}
              onPause={report}
              onSeeked={report}
              onTimeUpdate={reportNowAndThen}
              src={playing.src}
            />
            <AudioPlayerControlBar>
              <AudioPlayerPlayButton />
              <AudioPlayerSeekBackwardButton seekOffset={15} />
              <AudioPlayerSeekForwardButton seekOffset={30} />
              <AudioPlayerTimeDisplay />
              <AudioPlayerTimeRange />
              <AudioPlayerDurationDisplay />
              <AudioPlayerMuteButton />
              <AudioPlayerVolumeRange />
            </AudioPlayerControlBar>
          </AudioPlayer>
          {problem === null ? null : (
            <div className="flex items-center gap-2">
              <p className="text-destructive text-sm" role="alert">
                {problem}
              </p>
              <Button onClick={retry} size="sm" variant="outline">
                Retry audio
              </Button>
            </div>
          )}
        </section>
      )}
    </PlayerContext>
  );
};
