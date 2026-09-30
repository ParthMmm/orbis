import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: [
    ...core.ignorePatterns,
    // shadcn generates these; `shadcn add` overwrites any hand edits.
    "apps/web/src/components/ui/**",
    "apps/web/src/components/ai-elements/**",
  ],
});
