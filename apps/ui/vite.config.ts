import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 6731,
    proxy: {
      "/ws/": {
        target: "http://127.0.0.1:6730",
        ws: true,
      },
      "/icons/": "http://127.0.0.1:6730",
      "/app-icon": "http://127.0.0.1:6730",
    },
  },
});
