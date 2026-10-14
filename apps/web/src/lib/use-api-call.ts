import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { problemFor } from "@/lib/orbis";
import type { ApiResult } from "@/lib/orbis";

/**
 * One control's API calls. `run` keeps a failure for the control to show;
 * `change` also reloads the route's data after a call that changed it.
 */
export const useApiCall = () => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async <A>(
    call: () => Promise<ApiResult<A>>
  ): Promise<A | null> => {
    setBusy(true);
    setProblem(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setProblem(problemFor(result));
      return null;
    }
    return result.value;
  };
  const change = async <A>(
    call: () => Promise<ApiResult<A>>
  ): Promise<A | null> => {
    const value = await run(call);
    if (value !== null) {
      await router.invalidate();
    }
    return value;
  };
  return { busy, change, problem, refuse: setProblem, run };
};
