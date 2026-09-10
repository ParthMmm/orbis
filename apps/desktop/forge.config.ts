import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
const config: ForgeConfig = {
	packagerConfig: { asar: true },
	plugins: [
		new VitePlugin({
			build: [
				{ entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
			],
			renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
		}),
	],
};
export default config;
