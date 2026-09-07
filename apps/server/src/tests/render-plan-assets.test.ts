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

  /**
   * `render-plan-roundtrip.test.ts` 는 서버 직렬화의 **사본**으로 왕복을 증명한다.
   * 사본이 진짜와 어긋나면 그 증명이 통째로 헛돈다 — 어긋나는 방식은 거의 항상 하나,
   * **여기서 기본값을 채우는 것**이다(`?? null`, `?? 0`, `?? false`).
   *
   * `RenderShortOpts` 는 `undefined`("안 정했다")와 `null`("없음")을 다르게 읽는다.
   * 직렬화가 그걸 통일하면 편집자 PC 만 다른 기하로 굽는다. 실제로 타입이 한 번 잡았고,
   * 타입이 못 잡는 자리(`speed ?? 1` 처럼 같은 타입으로 떨어지는 것)를 이게 잡는다.
   */
  it("**계획을 만들며 값을 손보지 않는다** — 기본값을 채우면 서버가 안 한 판단이 된다", () => {
    const body = serializer();
    const block = body.slice(body.indexOf("render: {"), body.indexOf("assets: {"));
    assert.ok(block.length > 100, "render 블록을 못 떼어냈다 — 스캔이 깨졌다");

    const coercions = [...block.matchAll(/^\s*(\w+):.*\?\?\s*(?!undefined)(\S+?),?\s*$/gm)]
      .map((m) => `${m[1]} ?? ${m[2]}`);
    assert.deepEqual(coercions, [],
      `직렬화가 기본값을 채운다: ${coercions.join(", ")}\n` +
      "→ undefined 와 null 이 섞이면 편집자 PC 가 서버와 다른 기하로 굽는다. 그대로 실을 것.");
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

/**
 * **계획 요청이 진짜 렌더가 되어 버리는 구멍.**
 *
 * `renderClipMedia` 에는 굽는 경로가 둘이다 — `renderShort`(자막·오버레이가 있을 때)와
 * `trimEncode`(아무것도 없는 순수 16:9 트림). 계획 모드를 `renderShort` 쪽에만 달았더니,
 * 단순 클립은 그대로 빠른 경로로 새서 **굽고·올리고·미디어 행까지 만들고** 돌아왔다.
 * 편집자가 보기엔 "계획만 물었는데 클립이 생겼다" 다.
 *
 * 실제로 그렇게 만들었다가 잡은 것이라, 되돌아오지 못하게 여기 고정한다.
 */
describe("계획 모드는 굽지 않는다", () => {
  /** `renderClipMedia` 본문. */
  function renderClipMedia(): string {
    const start = INDEX.indexOf("async function renderClipMedia(");
    assert.ok(start > 0, "renderClipMedia 를 못 찾았다");
    const end = INDEX.indexOf("\n}\n", start);
    assert.ok(end > start, "함수의 끝을 못 찾았다");
    return INDEX.slice(start, end);
  }

  it("**굽는 경로마다 planOnly 를 먼저 본다** — 하나라도 빠지면 조용히 렌더된다", () => {
    const body = renderClipMedia();
    const bakes = [...body.matchAll(/^\s*await (trimEncode|renderShort)\(/gm)];
    assert.ok(bakes.length >= 2, `굽는 호출을 ${bakes.length}개만 찾았다 — 스캔이 깨졌다`);

    for (const m of bakes) {
      // 그 호출 앞 900자 안에 planOnly 판정이 있어야 한다. 창을 넉넉히 잡는 이유:
      // 좁으면 주석 한 줄 늘어난 날 멀쩡한 코드가 빨개진다 — 사람이 무시하는 관문이 된다.
      const before = body.slice(Math.max(0, m.index! - 900), m.index!);
      assert.match(before, /opts\.planOnly/,
        `\`await ${m[1]}(\` 앞에 planOnly 판정이 없다 — 계획을 물었는데 진짜로 굽는다.`);
    }
  });

  it("임시 파일 청소는 '계획을 요청했나' 가 아니라 **'실제로 넘겼나'** 로 가른다", () => {
    const body = renderClipMedia();
    assert.ok(body.includes("if (!handedOffTemps)"),
      "청소 조건이 handedOffTemps 가 아니다 — 계획을 못 준 경우까지 '남긴다' 로 묶여 /tmp 에 쌓인다");
    // 넘겼다고 표시하는 곳은 계획을 실제로 반환하는 그 자리 하나뿐이어야 한다.
    const marks = [...body.matchAll(/handedOffTemps = true/g)];
    assert.equal(marks.length, 1, `handedOffTemps 를 ${marks.length}곳에서 켠다 — 한 곳이어야 한다`);
  });

  it("계획을 못 주면 라우트가 굽지 않고 사유를 낸다", () => {
    assert.ok(INDEX.includes('"planUnavailable" in rendered'),
      "라우트가 planUnavailable 을 안 본다 — 못 준 계획이 정상 export 응답으로 나간다");
    assert.match(INDEX, /error: "plan_unavailable"/);
  });
});
