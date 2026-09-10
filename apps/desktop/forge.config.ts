import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
const config: ForgeConfig = {
	packagerConfig: { asar: true },
	plugins: [
		new VitePlugin({
			build: [
				{ entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
				{
					entry: "src/preload.ts",
					config: "vite.main.config.ts",
					target: "preload",
				},
			],
			renderer: [{ name: "main_window", config: "vite.config.ts" }],
		}),
	],
};
export default config;
