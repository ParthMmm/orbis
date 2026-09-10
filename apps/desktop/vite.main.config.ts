import { defineConfig } from "vite";

export default defineConfig({
  // Forge emits CommonJS; retain module-relative paths in the main bundle.
  define: { "import.meta.dirname": "__dirname" },
});
