import { useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { FAILURE_MESSAGES } from "@/lib/orbis";

/** A route whose data could not load, with a retry that re-runs its loaders. */
export const RouteProblem = ({ error }: ErrorComponentProps) => {
  const router = useRouter();
  // Invalidating re-runs beforeLoad and the loaders; resetting alone would not.
  const retry = () => router.invalidate();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <p className="text-destructive max-w-sm text-center text-sm" role="alert">
        {error instanceof Error ? error.message : FAILURE_MESSAGES.failed}
      </p>
      <Button onClick={retry} variant="outline">
        Try again
      </Button>
    </main>
  );
};
