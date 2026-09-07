/**
 * 동봉 ffmpeg·글꼴 배선 — **조용히 틀리면 결과물이 달라지는 자리**라 못박는다.
 *
 * 여기서 잘못되면 나는 증상이 둘인데 **둘 다 에러가 안 난다**:
 *   · ffmpeg 을 못 찾으면 → 렌더가 실패하고 서버로 폴백(느려질 뿐 결과는 맞다)
 *   · 글꼴을 못 찾으면 → libass 가 **조용히 다른 글꼴로 대체**해 그대로 고객 채널에 나간다
 * 두 번째가 훨씬 나쁘다. 그래서 글꼴 경로 주입을 테스트로 고정한다.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { applyBundledRenderEnv, canRenderLocally, resolveBundled } from "../render/bundled-ffmpeg.js";

let res = "";

before(async () => {
  res = await mkdtemp(path.join(os.tmpdir(), "stepd-res-"));
  await mkdir(path.join(res, "ffmpeg"), { recursive: true });
  await mkdir(path.join(res, "fonts"), { recursive: true });
  await writeFile(path.join(res, "ffmpeg", "ffmpeg.exe"), "x");
  await writeFile(path.join(res, "ffmpeg", "ffprobe.exe"), "x");
  await writeFile(path.join(res, "fonts", "Pretendard-Bold.otf"), "x");
});

after(async () => {
  await rm(res, { recursive: true, force: true }).catch(() => {});
});

describe("동봉 경로 해석", () => {
  it("패키징된 앱에서 ffmpeg·ffprobe·글꼴을 찾는다", () => {
    const p = resolveBundled(res, true);
    assert.equal(p.ffmpeg, path.join(res, "ffmpeg", "ffmpeg.exe"));
    assert.equal(p.ffprobe, path.join(res, "ffmpeg", "ffprobe.exe"));
    assert.equal(p.fontsDir, path.join(res, "fonts"));
  });

  it("**개발 중에는 아무것도 안 한다** — 없는 경로를 박으면 개발 PC 렌더가 통째로 죽는다", () => {
    const p = resolveBundled(res, false);
    assert.deepEqual(p, { ffmpeg: null, ffprobe: null, fontsDir: null });
  });

  it("파일이 없으면 null 이다 — 있다고 우기지 않는다", () => {
    const p = resolveBundled(path.join(res, "없는곳"), true);
    assert.equal(p.ffmpeg, null);
    assert.equal(p.fontsDir, null);
  });
});

describe("env 주입", () => {
  it("셋을 심는다 — 글꼴까지 넣어야 libass 가 우리 글꼴을 쓴다", () => {
    const env: NodeJS.ProcessEnv = {};
    applyBundledRenderEnv(resolveBundled(res, true), env);
    assert.ok(env.STEPD_FFMPEG?.endsWith("ffmpeg.exe"));
    assert.ok(env.STEPD_FFPROBE?.endsWith("ffprobe.exe"));
    assert.equal(env.STEPD_FONTS_DIR, path.join(res, "fonts"));
  });

  it("사람이 지정해 둔 값은 안 덮는다 — 특정 빌드로 시험하는 걸 앱이 되돌리면 안 된다", () => {
    const env: NodeJS.ProcessEnv = { STEPD_FFMPEG: "D:\\my\\ffmpeg.exe" };
    applyBundledRenderEnv(resolveBundled(res, true), env);
    assert.equal(env.STEPD_FFMPEG, "D:\\my\\ffmpeg.exe");
    // 나머지는 그대로 채운다.
    assert.ok(env.STEPD_FONTS_DIR);
  });

  it("개발 중에는 env 를 건드리지 않는다", () => {
    const env: NodeJS.ProcessEnv = {};
    applyBundledRenderEnv(resolveBundled(res, false), env);
    assert.deepEqual(env, {});
  });
});

describe("로컬 렌더 가능 판정", () => {
  it("실재하는 바이너리가 있어야 참이다 — 경로만 있고 파일이 없으면 거짓", () => {
    assert.equal(canRenderLocally({ STEPD_FFMPEG: path.join(res, "ffmpeg", "ffmpeg.exe") }), true);
    assert.equal(canRenderLocally({ STEPD_FFMPEG: path.join(res, "없다.exe") }), false);
    assert.equal(canRenderLocally({}), false);
    assert.equal(canRenderLocally({ STEPD_FFMPEG: "   " }), false);
  });
});
