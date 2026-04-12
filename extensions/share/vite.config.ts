import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "src/index.js",
    },
    outDir: resolve(__dirname, "../../dist/extensions/share"),
    emptyOutDir: false,
    rollupOptions: {
      // Don't externalize anything — bundle all deps into one file
      external: [],
    },
  },
});
