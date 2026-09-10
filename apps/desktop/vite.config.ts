import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [tailwindcss()],
	resolve: {
		// Resolve transitive dependencies from Bun's real package paths.
		preserveSymlinks: false,
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
});
