import { DotsThreeIcon } from "@phosphor-icons/react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelDownload,
  removeSet,
  renameSet,
  requestDownload,
  updateTags,
} from "@/lib/library";
import type { SavedSet } from "@/lib/library";
import { FAILURE_MESSAGES } from "@/lib/orbis";
import type { ApiResult, Credentials } from "@/lib/orbis";

type Dialogs = "rename" | "tags" | "remove";

const SOURCE_LABELS = { soundcloud: "SoundCloud", youtube: "YouTube" } as const;

const duration = (seconds: number | null): string | null => {
  if (seconds === null) {
    return null;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const DownloadBadge = ({
  progress,
  set,
}: {
  readonly progress: number | undefined;
  readonly set: SavedSet;
}) => {
  switch (set.downloadState) {
    case "ready": {
      return <Badge variant="secondary">Audio kept</Badge>;
    }
    case "queued": {
      return <Badge variant="outline">Waiting to download</Badge>;
    }
    case "downloading": {
      return (
        <Badge variant="outline">
          {progress === undefined
            ? "Downloading"
            : `Downloading ${Math.round(progress * 100)}%`}
        </Badge>
      );
    }
    case "failed": {
      return <Badge variant="destructive">Download failed</Badge>;
    }
    default: {
      return null;
    }
  }
};

/** Tags as the Person types them: comma separated, trimmed, without repeats. */
const parseTags = (text: string): string[] => [
  ...new Set(
    text
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "")
  ),
];

const TextDialog = ({
  label,
  onClose,
  onSave,
  title,
  value,
}: {
  readonly label: string;
  readonly onClose: () => void;
  readonly onSave: (text: string) => Promise<ApiResult<unknown>>;
  readonly title: string;
  readonly value: string;
}) => {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const result = await onSave(
      String(new FormData(event.currentTarget).get("value") ?? "")
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
        <form className="flex flex-col gap-4" onSubmit={save}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="set-dialog-value">{label}</Label>
            <Input defaultValue={value} id="set-dialog-value" name="value" />
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

export const SetRow = ({
  credentials,
  progress,
  set,
}: {
  readonly credentials: Credentials;
  readonly progress: number | undefined;
  readonly set: SavedSet;
}) => {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const settle = async (result: ApiResult<unknown>, limited?: string) => {
    if (result.ok) {
      setProblem(null);
      await router.invalidate();
      return;
    }
    setProblem(
      result.failure === "limited" && limited !== undefined
        ? limited
        : FAILURE_MESSAGES[result.failure]
    );
  };
  const close = async () => {
    setDialog(null);
    await router.invalidate();
  };
  const downloadable = ["none", "failed", "canceled"].includes(
    set.downloadState
  );
  const inFlight =
    set.downloadState === "queued" || set.downloadState === "downloading";
  const length = duration(set.durationSeconds);
  return (
    <li className="flex items-start gap-4 border-b py-4">
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
        <h2 className="truncate font-medium">{set.title}</h2>
        <p className="text-muted-foreground text-sm">
          {[set.creator ?? "Unknown creator", SOURCE_LABELS[set.source], length]
            .filter((part) => part !== null)
            .join(" · ")}
        </p>
        <div className="flex flex-wrap gap-1">
          <DownloadBadge progress={progress} set={set} />
          {set.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
        {problem === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`Actions for ${set.title}`}
              size="icon"
              variant="ghost"
            />
          }
        >
          <DotsThreeIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {downloadable ? (
            <DropdownMenuItem
              onClick={async () =>
                settle(
                  await requestDownload(credentials, set.id),
                  "The Download queue is full. Try again later."
                )
              }
            >
              Download
            </DropdownMenuItem>
          ) : null}
          {inFlight ? (
            <DropdownMenuItem
              onClick={async () =>
                settle(await cancelDownload(credentials, set.id))
              }
            >
              Cancel Download
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setDialog("rename")}>
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog("tags")}>
            Edit Tags…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setDialog("remove")}
            variant="destructive"
          >
            Remove…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "rename" ? (
        <TextDialog
          label="Title"
          onClose={close}
          onSave={(text) => renameSet(credentials, set.id, text.trim())}
          title={`Rename ${set.title}`}
          value={set.title}
        />
      ) : null}
      {dialog === "tags" ? (
        <TextDialog
          label="Tags, separated by commas"
          onClose={close}
          onSave={(text) => updateTags(credentials, set.id, parseTags(text))}
          title={`Tags for ${set.title}`}
          value={set.tags.join(", ")}
        />
      ) : null}
      <AlertDialog
        onOpenChange={(open) => setDialog(open ? "remove" : null)}
        open={dialog === "remove"}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {set.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves your Library. Other People who saved it keep it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <Button
              onClick={async () => {
                setDialog(null);
                await settle(await removeSet(credentials, set.id));
              }}
              variant="destructive"
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
};
