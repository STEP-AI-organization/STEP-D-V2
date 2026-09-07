/**
 * ffmpeg 실행 파일 경로는 **주입 가능해야 한다** — 편집자 PC 로컬 렌더의 전제다.
 *
 * ## 왜 이 테스트가 있나
 *
 * 클립 렌더를 편집자 PC 에서 굽는다(서버 부담·egress 절감 · 원본이 이미 로컬에 있다).
 * 그때 **렌더 구현이 두 벌이 되면 같은 클립이 굽는 곳마다 달라진다** — 자막이 몇 픽셀
 * 밀리고, 폰트가 조용히 대체되고, 아무도 눈치 못 챈다. 이 리포가 제일 싫어하는 실패다.
 *
 * 그래서 복제하지 않고 **네이티브가 `media/ffmpeg.ts` 를 그대로 import** 한다. 그게 가능한
 * 이유는 이 파일의 의존이 `node:child_process`·`node:fs` 뿐이기 때문이고, 갈리는 값은
 * **바이너리 위치 하나**뿐이다.
 *
 * 이 테스트가 지키는 것 둘:
 *   1. `execFile("ffmpeg", …)` 하드코딩이 돌아오지 않는다 (돌아오면 네이티브가 PATH 를 찾다 실패)
 *   2. 이 파일이 무거운 의존을 새로 들이지 않는다 (들이면 네이티브가 더는 못 가져간다)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..");
const FFMPEG = fs.readFileSync(path.join(SRC, "media", "ffmpeg.ts"), "utf8");

/** 주석을 뺀 실행 줄만 — 설명문에 예시로 적힌 문자열에 걸리지 않게. */
function code(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((ln) => {
      const t = ln.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("ffmpeg 바이너리 주입", () => {
  it("실행 파일 이름을 하드코딩하지 않는다", () => {
    const body = code(FFMPEG);
    assert.doesNotMatch(
      body,
      /execFile(Sync)?\(\s*"ffmpeg"/,
      'execFile("ffmpeg", …) 이 남아 있다 — 편집자 PC 에는 PATH 에 ffmpeg 이 없어 로컬 렌더가 깨진다',
    );
    assert.doesNotMatch(
      body,
      /^\s*"ffprobe",\s*$/m,
      'execFile 인자에 "ffprobe" 가 하드코딩돼 있다',
    );
  });

  it("주입 지점이 함수 두 개로 모여 있다 — 흩뿌리면 한쪽만 고쳐진다", () => {
    assert.match(FFMPEG, /export function ffmpegBin\(\): string \{/);
    assert.match(FFMPEG, /export function ffprobeBin\(\): string \{/);
  });

  it("기본값은 PATH 의 ffmpeg 다 — 서버는 지금까지와 똑같이 돈다", () => {
    // env 를 안 주면 서버 이미지(apt 설치본)를 그대로 쓴다. 무회귀의 근거다.
    assert.match(FFMPEG, /process\.env\.STEPD_FFMPEG[\s\S]{0,40}\|\| "ffmpeg"/);
    assert.match(FFMPEG, /process\.env\.STEPD_FFPROBE[\s\S]{0,40}\|\| "ffprobe"/);
  });

  /**
   * ⚠️ 이 테스트가 깨지면 **네이티브가 이 모듈을 더는 못 가져간다.**
   * DB·GCS·Vertex 같은 걸 하나라도 들이는 순간 렌더를 복제할 수밖에 없어지고,
   * 그러면 굽는 곳마다 결과가 달라진다. 새 의존이 정말 필요하면 그 부분을 다른 파일로
   * 빼고 여기는 순수하게 남길 것.
   */
  it("의존이 node 표준 모듈뿐이다 — 네이티브가 그대로 가져갈 수 있어야 한다", () => {
    const imports = [...FFMPEG.matchAll(/^import\s.*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0, "import 를 하나도 못 찾았다 — 정규식을 확인할 것");
    for (const spec of imports) {
      assert.ok(
        spec.startsWith("node:"),
        `ffmpeg.ts 가 ${spec} 를 들였다 — 네이티브가 이 모듈을 못 가져가게 된다`,
      );
    }
  });
});
