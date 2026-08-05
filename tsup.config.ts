import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "server/index": "src/server/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: false,
  splitting: false,
  sourcemap: false,
  // Runtime dependencies must be installed for the target OS. Never bundle native .node files.
  external: ["better-sqlite3", "keytar"],
});
