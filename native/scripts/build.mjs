import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  sourcemap: true,
  // ⚠️ electron-updater 는 **번들하지 않는다.** 런타임에 app-update.yml 을 찾고
  //    asar 밖 경로를 계산하는 코드가 있어, 번들되면 그 경로 추정이 깨진다.
  //    electron-builder 가 node_modules 채로 패키징한다(그래서 dependencies 다).
  external: ["electron", "electron-updater"],
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
    entryPoints: ["src/workspace-preload.ts"],
    outfile: "dist/workspace-preload.cjs",
    format: "cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/contract.ts"],
    outfile: "dist/contract.js",
    format: "esm",
  }),
]);
