import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const config: ForgeConfig = {
  packagerConfig: { asar: true },
  plugins: [
    new VitePlugin({
      build: [
        { config: "vite.main.config.ts", entry: "src/main.ts", target: "main" },
        {
          config: "vite.main.config.ts",
          entry: "src/preload.ts",
          target: "preload",
        },
      ],
      renderer: [{ config: "vite.config.ts", name: "main_window" }],
    }),
  ],
};
export default config;
