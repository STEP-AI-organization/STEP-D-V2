/**
 * 렌더 계획이 **자산을 빠뜨리지 않는가** — 소스 스캔 아키텍처 테스트.
 *
 * 로컬 렌더의 약속은 "편집자 PC 가 구운 것과 서버가 구운 것이 같다" 이고, 그 약속은
 * `media/ffmpeg.ts` 를 **양쪽이 같이 쓰기 때문에** 구조적으로 지켜진다. 딱 한 군데만
 * 예외다 — **로컬 경로를 받는 필드**. 서버의 `/tmp/...` 는 편집자 PC 에 없으므로
 * `serializeRenderPlan` 이 그 값을 본문이나 URL 로 바꿔 실어야 한다.
 *
 * 그래서 여기서 보는 것: `RenderShortOpts` 에 경로 필드가 새로 생겼는데 계획이 그걸
 * 모르면 **실패한다**. 이게 없으면 새 자산이 추가된 날, 편집자 PC 가 구운 영상에만
 * 그 자산이 빠진 채로 배포된다 — 아무도 에러를 못 보고 결과물만 다르다.
 * (이 리포 최빈 실패모드: 기능은 있는데 출력이 소비처에 미도달.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const SRC = path.join(import.meta.dirname, "..");
/**
 * ⚠️ 줄끝을 반드시 통일한다 — 이 리포는 CRLF 라 개행이 들어간 표지가 그냥 안 맞는다.
 * 안 맞으면 함수 본문 추출이 **파일 전체**로 늘어나서, 아래 테스트가 남의 코드를 보고
 * 통과·실패한다(실제로 그렇게 헛돌았다).
 */
const read = (...p: string[]) =>
  fs.readFileSync(path.join(SRC, ...p), "utf-8").replace(/\r\n/g, "\n");
const FFMPEG = read("media", "ffmpeg.ts");
const INDEX = read("index.ts");

/** `serializeRenderPlan` 함수 본문만 떼어낸다 — index.ts 전체를 훑으면 남의 코드에 걸린다. */
function serializer(): string {
  const start = INDEX.indexOf("async function serializeRenderPlan(");
  assert.ok(start > 0, "serializeRenderPlan 이 사라졌다 — 로컬 렌더 계획이 없어진 것이다");
  const end = INDEX.indexOf("\n}\n", start);
  return INDEX.slice(start, end);
}

/** `RenderShortOpts` 안의 경로 필드를 전부 모은다(중첩 객체 포함). */
function pathFields(): string[] {
  const start = FFMPEG.indexOf("export type RenderShortOpts = {");
  assert.ok(start > 0, "RenderShortOpts 를 못 찾았다");
  // 다음 최상위 선언 전까지가 이 인터페이스다.
  const rest = FFMPEG.slice(start + 1);
  const end = rest.search(/\nexport (interface|type|function|const|async)/);
  const body = rest.slice(0, end > 0 ? end : rest.length);
  return [...new Set([...body.matchAll(/^\s*(\w*(?:Path|Dir))\??:/gm)].map((m) => m[1]))];
}

describe("렌더 계획 — 경로 자산", () => {
  it("**경로 필드가 전부 계획에 실린다** (새 자산이 조용히 빠지지 않게)", () => {
    /**
     * 계획이 일부러 안 싣는 둘. 뺀 이유를 여기 적어 둔다 — 나중에 "왜 빠졌지" 로
     * 다시 열어 보지 않게.
     *   inputPath  — 원본. **편집자 PC 의 작업 공간에 이미 있다.** 이걸 URL 로 주면
     *                60분 원본을 다시 내려받는 셈이라 로컬 렌더의 이유가 사라진다.
     *   outputPath — 결과. 굽는 쪽이 자기 임시 자리에 만들고 `output.objectPath` 로 올린다.
     */
    const deliberatelyOmitted = new Set(["inputPath", "outputPath"]);
    const body = serializer();

    const missing = pathFields()
      .filter((f) => !deliberatelyOmitted.has(f))
      .filter((f) => !body.includes(f));

    assert.deepEqual(missing, [],
      `RenderShortOpts 의 경로 필드가 계획에 안 실렸다: ${missing.join(", ")}\n` +
      "→ 서버는 그 자산을 쓰는데 편집자 PC 는 못 받는다. 결과물이 조용히 달라진다.\n" +
      "  serializeRenderPlan(index.ts)에 본문(ASS) 또는 업로드 URL(그 외)로 추가할 것.");
  });

  it("표본이 비어 있지 않다 — 정규식이 헛돌면 위 테스트가 늘 통과한다", () => {
    const found = pathFields();
    assert.ok(found.length >= 5, `경로 필드를 ${found.length}개밖에 못 찾았다 — 스캔이 깨졌다`);
    assert.ok(found.includes("assPath") && found.includes("ttsPath"), `표본이 이상하다: ${found}`);
  });

  it("임시 파일을 치운다 — planOnly 는 renderClipMedia 가 안 지우고 넘긴 것이다", () => {
    const body = serializer();
    assert.ok(/finally\s*\{[\s\S]*unlinkSync/.test(body),
      "계획을 만들고 임시 파일을 안 지운다 — Cloud Run 의 /tmp 는 RAM 이라 쌓이면 OOM 이다");
  });

  it("원본 바이트를 계획에 싣지 않는다 — 안 옮기는 게 이 설계의 목적이다", () => {
    const body = serializer();
    assert.ok(!/signedReadUrl\(\s*parseObjectPath\(\s*(ctx\.)?master\.path/.test(body),
      "계획이 원본 다운로드 URL 을 준다 — 그러면 로컬 렌더가 대역폭을 아끼지 못한다");
  });
});
