import { Link } from "@tanstack/react-router";
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
import { replaceSetPlaylists } from "@/lib/playlists";
import type { Playlist } from "@/lib/playlists";

export const AddToPlaylistDialog = ({
  credentials,
  onClose,
  playlists,
  set,
}: {
  readonly credentials: Credentials;
  readonly onClose: () => void;
  readonly playlists: readonly Playlist[];
  readonly set: SavedSet;
}) => {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    new Set(set.playlistIds)
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(chosen);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setChosen(next);
  };
  const save = async () => {
    setPending(true);
    const result = await replaceSetPlaylists(
      credentials,
      set.id,
      playlists
        .filter((playlist) => chosen.has(playlist.id))
        .map((playlist) => playlist.id)
    );
    setPending(false);
    if (result.ok) {
      onClose();
      return;
    }
    setProblem(FAILURE_MESSAGES[result.failure]);
  };
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {set.title} to Playlists</DialogTitle>
          <DialogDescription>
            {playlists.length === 0
              ? "You have no Playlists yet."
              : "It goes at the end of each Playlist you add it to. Clear a box to take it out."}
          </DialogDescription>
        </DialogHeader>
        {playlists.length === 0 ? (
          <Link className="text-sm underline" to="/playlists">
            Create a Playlist
          </Link>
        ) : (
          <ul aria-label="Your Playlists" className="flex flex-col gap-3">
            {playlists.map((playlist) => (
              <li key={playlist.id}>
                <label className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={chosen.has(playlist.id)}
                    onCheckedChange={(checked) => toggle(playlist.id, checked)}
                  />
                  {playlist.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        {problem === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        )}
        {playlists.length === 0 ? null : (
          <DialogFooter>
            <Button disabled={pending} onClick={save}>
              Save
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
