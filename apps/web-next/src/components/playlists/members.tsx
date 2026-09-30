import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { Credentials } from "@/lib/orbis";
import { replaceMembers } from "@/lib/playlists";
import type { PlaylistDetail } from "@/lib/playlists";

const pickerHint = (emptyLibrary: boolean, candidates: number) => {
  if (emptyLibrary) {
    return "Your Library has no Sets. Save a Set in your Library first.";
  }
  return candidates === 0
    ? "Every Set in your Library is already in this Playlist."
    : "Choose Sets from your Library. They go at the end, in the order you choose them.";
};

/** Library Sets not yet in the Playlist; they join at the end in the order picked. */
const AddSetsDialog = ({
  candidates,
  emptyLibrary,
  onAdd,
  onClose,
  pending,
  playlistName,
}: {
  readonly candidates: readonly SavedSet[];
  readonly emptyLibrary: boolean;
  readonly onAdd: (setIds: readonly string[]) => Promise<void>;
  readonly onClose: () => void;
  readonly pending: boolean;
  readonly playlistName: string;
}) => {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const toggle = (id: string, checked: boolean) =>
    setChosen(
      checked ? [...chosen, id] : chosen.filter((picked) => picked !== id)
    );
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Sets to {playlistName}</DialogTitle>
          <DialogDescription>
            {pickerHint(emptyLibrary, candidates.length)}
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? null : (
          <ul
            aria-label="Sets in your Library"
            className="flex max-h-80 flex-col gap-3 overflow-y-auto"
          >
            {candidates.map((set) => (
              <li key={set.id}>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={chosen.includes(set.id)}
                    onCheckedChange={(checked) => toggle(set.id, checked)}
                  />
                  <span className="truncate">{set.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            disabled={pending || chosen.length === 0}
            onClick={() => onAdd(chosen)}
          >
            {chosen.length > 1 ? `Add ${chosen.length} Sets` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The Playlist's Sets in order. The creator and every editor may add, remove,
 * and reorder them (ADR 0010); each change replaces the whole order at once.
 */
export const Members = ({
  credentials,
  library,
  playlist,
}: {
  readonly credentials: Credentials;
  readonly library: readonly SavedSet[];
  readonly playlist: PlaylistDetail;
}) => {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = playlist.sets.map((set) => set.id);
  const change = async (setIds: readonly string[]) => {
    setPending(true);
    const result = await replaceMembers(credentials, playlist.id, setIds);
    if (result.ok) {
      setProblem(null);
      setAdding(false);
      await router.invalidate();
    } else {
      setProblem(
        result.status === 404
          ? "You can no longer change this Playlist."
          : FAILURE_MESSAGES[result.failure]
      );
    }
    setPending(false);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const [id] = next.splice(index, 1);
    if (id !== undefined) {
      next.splice(index + by, 0, id);
      void change(next);
    }
  };
  const members = new Set(ids);
  return (
    <section aria-labelledby="members-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-medium" id="members-heading">
          Sets
        </h2>
        <Button onClick={() => setAdding(true)} variant="outline">
          Add Sets…
        </Button>
      </div>
      {problem === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      )}
      {playlist.sets.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This Playlist has no Sets yet.
        </p>
      ) : (
        <ol aria-label="Sets in this Playlist" className="divide-y">
          {playlist.sets.map((set, index) => (
            <li className="flex items-center gap-3 py-3" key={set.id}>
              <span className="text-muted-foreground w-6 text-right text-sm tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {set.title}
              </span>
              <Button
                aria-label={`Move ${set.title} up`}
                disabled={pending || index === 0}
                onClick={() => move(index, -1)}
                size="icon"
                variant="ghost"
              >
                <ArrowUpIcon />
              </Button>
              <Button
                aria-label={`Move ${set.title} down`}
                disabled={pending || index === playlist.sets.length - 1}
                onClick={() => move(index, 1)}
                size="icon"
                variant="ghost"
              >
                <ArrowDownIcon />
              </Button>
              <Button
                aria-label={`Remove ${set.title} from ${playlist.name}`}
                disabled={pending}
                onClick={() => change(ids.filter((id) => id !== set.id))}
                size="sm"
                variant="outline"
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
      )}
      {adding ? (
        <AddSetsDialog
          candidates={library.filter((set) => !members.has(set.id))}
          emptyLibrary={library.length === 0}
          onAdd={(setIds) => change([...ids, ...setIds])}
          onClose={() => setAdding(false)}
          pending={pending}
          playlistName={playlist.name}
        />
      ) : null}
    </section>
  );
};
