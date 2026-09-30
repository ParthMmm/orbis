import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { audioState } from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import type { Credentials } from "@/lib/orbis";

const POLL_MS = 1500;

const inFlight = (set: SavedSet) =>
  set.downloadState === "queued" || set.downloadState === "downloading";

/**
 * Polls the Downloads still in flight and returns each one's fraction received.
 * When any of them settles, the page's loaders re-run so the list shows the result.
 */
export const useDownloadProgress = (
  { apiUrl, key }: Credentials,
  sets: readonly SavedSet[]
): ReadonlyMap<string, number> => {
  const router = useRouter();
  const [progress, setProgress] = useState<ReadonlyMap<string, number>>(
    new Map()
  );
  const watched = sets
    .filter(inFlight)
    .map((set) => set.id)
    .join(",");
  useEffect(() => {
    if (watched === "") {
      return;
    }
    const ids = watched.split(",");
    const poll = async () => {
      const states = await Promise.all(
        ids.map(async (id) => ({
          id,
          result: await audioState({ apiUrl, key }, id),
        }))
      );
      const next = new Map<string, number>();
      let settled = false;
      for (const { id, result } of states) {
        if (!result.ok) {
          continue;
        }
        const { bytesReceived, bytesTotal, state } = result.value;
        if (state !== "queued" && state !== "downloading") {
          settled = true;
        } else if (bytesTotal !== null && bytesTotal > 0) {
          next.set(id, bytesReceived / bytesTotal);
        }
      }
      setProgress(next);
      if (settled) {
        await router.invalidate();
      }
    };
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [apiUrl, key, router, watched]);
  return progress;
};
