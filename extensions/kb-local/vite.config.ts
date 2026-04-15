import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "src/index.js",
    },
    outDir: resolve(__dirname, "../../dist/extensions/kb-local"),
    emptyOutDir: false,
    rollupOptions: {
      external: [],
    },
  },
});
