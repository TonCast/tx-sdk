import { defineConfig } from "tsup";

export default defineConfig({
  entryPoints: ["src/"],
  format: ["esm", "cjs"],
  outDir: "dist",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
});
