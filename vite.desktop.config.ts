import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = fileURLToPath(new URL("./desktop", import.meta.url));
const desktopOutput = fileURLToPath(
  new URL("./dist-desktop", import.meta.url),
);

export default defineConfig({
  root: desktopRoot,
  base: "./",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  clearScreen: false,
  plugins: [react()],
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: desktopOutput,
    emptyOutDir: true,
    target: "es2021",
  },
});
