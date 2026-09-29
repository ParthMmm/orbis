import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        rewrite: (path) => path.replace(/^\/api/u, ""),
        target: "http://127.0.0.1:4311",
      },
    },
  },
});
