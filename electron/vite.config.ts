import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` is required: the packaged app loads the bundle with loadFile(),
// so asset URLs must be relative rather than rooted at "/".
export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
});
