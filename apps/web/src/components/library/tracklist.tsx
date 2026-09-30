import { Button } from "@/components/ui/button";

export interface Cue {
  readonly position: number;
  readonly startSeconds: number | null;
  readonly artist: string;
  readonly title: string;
  readonly artworkUrl: string | null;
}

const timeLabel = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return hours === 0
    ? `${minutes}:${remainder}`
    : `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`;
};

export const Tracklist = ({
  cues,
  currentSeconds,
  onRetry,
  onSeek,
  retrying,
  state,
}: {
  readonly cues: readonly Cue[];
  readonly currentSeconds: number | null;
  readonly onRetry: () => void;
  readonly onSeek: (seconds: number) => void;
  readonly retrying: boolean;
  readonly state: "pending" | "ready" | "none" | "failed";
}) => {
  if (state === "pending" || state === "none") {
    return null;
  }
  if (state === "failed") {
    return (
      <section aria-label="Tracklist" className="flex items-center gap-3">
        <p className="text-muted-foreground text-sm">Tracklist unavailable.</p>
        <Button
          disabled={retrying}
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </section>
    );
  }

  let currentPosition: number | null = null;
  if (currentSeconds !== null) {
    for (const cue of cues) {
      if (cue.startSeconds !== null && cue.startSeconds <= currentSeconds) {
        currentPosition = cue.position;
      }
    }
  }

  return (
    <section
      aria-labelledby="tracklist-heading"
      className="flex flex-col gap-4"
    >
      <h2 className="text-lg font-medium" id="tracklist-heading">
        Tracklist
      </h2>
      <ol aria-label="Tracklist" className="flex flex-col gap-1">
        {cues.map((cue) => {
          const active = cue.position === currentPosition;
          const { artworkUrl, startSeconds } = cue;
          const artwork = artworkUrl ? (
            <img
              alt=""
              className="size-11 shrink-0 rounded-sm object-cover"
              src={artworkUrl}
            />
          ) : (
            <span
              aria-hidden
              className="bg-muted size-11 shrink-0 rounded-sm"
            />
          );
          const details = (
            <>
              <span className="text-muted-foreground w-12 shrink-0 text-end text-sm tabular-nums">
                {startSeconds === null ? "—" : timeLabel(startSeconds)}
              </span>
              {artwork}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{cue.title}</span>
                <span className="text-muted-foreground block truncate text-sm">
                  {cue.artist}
                </span>
              </span>
            </>
          );
          return (
            <li key={cue.position}>
              {startSeconds === null ? (
                <div className="flex min-h-11 items-center gap-3 px-2 py-1">
                  {details}
                </div>
              ) : (
                <button
                  aria-current={active ? "true" : undefined}
                  aria-label={`${cue.title}, ${cue.artist}, starts at ${timeLabel(startSeconds)}`}
                  className="hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground focus-visible:ring-ring flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-1 text-start focus-visible:ring-2 focus-visible:outline-none"
                  onClick={() => onSeek(startSeconds)}
                  type="button"
                >
                  {details}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
