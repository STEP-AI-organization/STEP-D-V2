import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.cjs",
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/preload.ts"],
    outfile: "dist/preload.cjs",
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/contract.ts"],
    outfile: "dist/contract.js",
    format: "esm",
  }),
]);
