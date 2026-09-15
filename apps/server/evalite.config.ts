import { defineConfig } from "evalite/config";

export default defineConfig({
  maxConcurrency: 5,
  scoreThreshold: 80,
  testTimeout: 60_000,
});
