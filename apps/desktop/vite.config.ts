import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
    // Resolve transitive dependencies from Bun's real package paths.
    preserveSymlinks: false,
  },
});
