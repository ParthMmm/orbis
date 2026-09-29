import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Alchemy adds the Cloudflare plugin when it builds for deploy (ADR 0015).
export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  resolve: { tsconfigPaths: true },
});
