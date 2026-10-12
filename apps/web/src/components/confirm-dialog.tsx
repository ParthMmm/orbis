import { useState } from "react";

import { Problem } from "@/components/problem";
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
import type { ApiResult } from "@/lib/orbis";
import { useApiCall } from "@/lib/use-api-call";

/**
 * A destructive call behind a confirmation. The dialog stays open on failure and
 * shows why, and closes only after the call succeeds.
 */
export const ConfirmDialog = ({
  action,
  call,
  description,
  label,
  onDone,
  pendingAction,
  title,
  trigger,
}: {
  readonly action: string;
  readonly call: () => Promise<ApiResult<unknown>>;
  readonly description: string;
  readonly label: string;
  readonly onDone: () => Promise<void>;
  readonly pendingAction: string;
  readonly title: string;
  readonly trigger: string;
}) => {
  const [open, setOpen] = useState(false);
  const { busy, problem, refuse, run } = useApiCall();
  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      refuse(null);
    }
  };
  const confirm = async () => {
    if ((await run(call)) !== null) {
      setOpen(false);
      await onDone();
    }
  };
  return (
    <AlertDialog onOpenChange={openChange} open={open}>
      <AlertDialogTrigger
        render={<Button aria-label={label} size="sm" variant="outline" />}
      >
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <Problem message={problem} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={confirm}
            variant="destructive"
          >
            {busy ? pendingAction : action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
