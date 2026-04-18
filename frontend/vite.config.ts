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
      // Daemon API endpoints — forwarded so dev-server (:5173+) and
      // daemon (:7777) appear same-origin to the frontend.
      "^/(workspaces|status|hook|resolve|shutdown)": {
        target: "http://localhost:7777",
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://localhost:7777",
        ws: true,
      },
    },
  },
});
