import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../app/src/shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7777",
      "/ws": {
        target: "ws://localhost:7777",
        ws: true,
      },
    },
  },
});
