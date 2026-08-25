/**
 * 숏폼 길이 상한 불변식 — **자동배포로 나가는 세로 클립은 상한을 넘지 않는다.**
 *
 * 이 파일이 존재하는 이유는 하나다. 2026-08-25 프로덕션에서 **3분(180초)이 넘는 구간이
 * "숏폼" 으로 렌더·게시**됐다. 원인이 두 겹이었는데 둘 다 "없는 것" 이라 아무도 못 봤다.
 *
 *   (1) core 의 beat-only 추천 경로에 길이 상한이 **프롬프트 문구뿐**이었다. 결정론 캡
 *       (`_enforce_shortform_length`)은 정의만 되고 아무도 부르지 않았다.
 *   (2) factory·automation-cycle 이 `/api/clips/:id/export` 를 **본문 없이** 불렀다.
 *       라우트의 `resolveRenderPreset(body.channel, clip)` 는 채널이 없으면 null 을 주고,
 *       그러면 길이 캡(`capped`)이 통째로 비활성이라 원본 구간 길이 그대로 인코딩된다.
 *       무인 경로가 만든 클립엔 `targetChannel` 도 없으니(수동 adopt 라우트만 심는다)
 *       캡이 걸릴 방법이 **아예** 없었다.
 *
 * 증상이 "실패" 가 아니라 "그냥 길게 나감" 이라 로그에 아무것도 안 찍힌다. 사람이 결과물을
 * 보기 전엔 모른다 — 그래서 테스트로 잠근다. 순수 함수로 증명 안 되는 (2)는
 * `worker-lanes.test.ts`·`publish-guard.test.ts` 의 **소스 스캔 관용구**를 따른다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  SHORTFORM_MAX_SEC,
  SHORTS_RENDER_PRESETS,
  autoRenderChannel,
  capRenderWindow,
  isVerticalAspect,
  shortformSegmentTooLong,
} from "./channel-rules.ts";
import { factoryAspect } from "./factory.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SRC, "..", "..", "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");
const readRepo = (p: string) => fs.readFileSync(path.join(REPO, p), "utf-8");

describe("세로(숏폼) 판정", () => {
  it("에디터 5-값 enum 을 전부 세로로 읽는다", () => {
    for (const a of ["9:16", "9:16-letterbox", "9:16-crop-full", "9:16-crop-main", "9:16-crop-sub"]) {
      assert.equal(isVerticalAspect(a), true, a);
    }
  });

  it("가로·미지정은 세로가 아니다 — 롱폼에 숏폼 상한을 걸면 15분 클립이 조각난다", () => {
    for (const a of ["16:9", "1:1", "4:5", "", null, undefined, "이상한값"]) {
      assert.equal(isVerticalAspect(a), false, String(a));
    }
  });
});

describe("채택 게이트 (shortformSegmentTooLong)", () => {
  it("세로 + 상한 초과만 막는다", () => {
    assert.equal(shortformSegmentTooLong("9:16-crop-main", SHORTFORM_MAX_SEC + 0.1), true);
    assert.equal(shortformSegmentTooLong("9:16-crop-main", 293), true);
    assert.equal(shortformSegmentTooLong("9:16-crop-main", SHORTFORM_MAX_SEC), false);
    assert.equal(shortformSegmentTooLong("9:16-crop-main", 45), false);
  });

  it("가로(롱폼)는 길어도 통과한다 — 클립은 원래 길다(최대 15분)", () => {
    assert.equal(shortformSegmentTooLong("16:9", 900), false);
  });

  it("길이를 못 읽으면 막지 않는다 — 판정 불가로 자동배포를 멈추면 조용히 0건이 된다", () => {
    for (const v of [NaN, undefined, null, "이상한값"]) {
      assert.equal(shortformSegmentTooLong("9:16-crop-main", v), false, String(v));
    }
  });
});

describe("무인 렌더가 넘길 채널 프리셋 (autoRenderChannel)", () => {
  it("세로 + 아는 플랫폼이면 프리셋 키를 준다", () => {
    assert.equal(autoRenderChannel(["youtube"], "9:16-crop-main"), "youtube_shorts");
    assert.equal(autoRenderChannel(["instagram"], "9:16-crop-main"), "instagram_reels");
  });

  it("배포처가 여럿이면 **가장 빡빡한 상한**을 고른다 — 렌더는 클립당 한 번이다", () => {
    assert.equal(autoRenderChannel(["instagram", "youtube"], "9:16-crop-main"), "youtube_shorts");
    assert.equal(autoRenderChannel(["youtube", "instagram"], "9:16-crop-main"), "youtube_shorts");
  });

  it("가로는 null — 롱폼을 배포처 길이로 자르면 머리만 남는다", () => {
    assert.equal(autoRenderChannel(["youtube"], "16:9"), null);
  });

  it("모르는 플랫폼은 null (종전 동작 유지 · 무회귀)", () => {
    assert.equal(autoRenderChannel(["tiktok", "naverclip"], "9:16-crop-main"), null);
    assert.equal(autoRenderChannel([], "9:16-crop-main"), null);
  });

  it("대소문자·공백에 흔들리지 않는다 — 플랫폼 문자열은 DB 에서 온다", () => {
    assert.equal(autoRenderChannel([" YouTube "], "9:16-crop-main"), "youtube_shorts");
  });
});

describe("상한 값이 한 벌이다 (표가 갈라지면 캡이 거짓말을 한다)", () => {
  it("SHORTS_RENDER_PRESETS 의 maxSec = index.ts RENDER_PRESETS 의 maxSec", () => {
    const src = read("index.ts");
    const block = /const RENDER_PRESETS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1];
    assert.ok(block, "index.ts 에서 RENDER_PRESETS 를 못 찾았다 — 이 테스트의 파싱을 고쳐야 한다");
    const routeMax: Record<string, number> = {};
    for (const [, key, max] of block!.matchAll(/(\w+):\s*\{[^}]*maxSec:\s*(\d+)\s*\}/g)) {
      routeMax[key] = Number(max);
    }
    assert.ok(Object.keys(routeMax).length > 0, "RENDER_PRESETS 항목을 하나도 못 읽었다");
    for (const [platform, preset] of Object.entries(SHORTS_RENDER_PRESETS)) {
      assert.equal(routeMax[preset.key], preset.maxSec,
        `${platform} → ${preset.key}: channel-rules.ts 는 ${preset.maxSec}s 인데 `
        + `index.ts RENDER_PRESETS 는 ${routeMax[preset.key]}s 다`);
    }
  });

  it("SHORTFORM_MAX_SEC = core/recommend/recommend.py MAX_SHORT_SEC", () => {
    const py = readRepo("core/recommend/recommend.py");
    const n = Number(/^MAX_SHORT_SEC\s*=\s*(\d+)/m.exec(py)?.[1]);
    assert.ok(Number.isFinite(n), "core 에서 MAX_SHORT_SEC 를 못 읽었다");
    assert.equal(SHORTFORM_MAX_SEC, n,
      "숏폼의 정의(길이)가 core 와 서버에서 갈라졌다 — 한쪽만 고치면 게이트가 헛돈다");
  });
});

describe("렌더 창 클램프 (capRenderWindow) — /export 길이 캡의 본체", () => {
  it("상한 이내면 손대지 않는다", () => {
    const r = capRenderWindow(60, 100, 145);
    assert.equal(r.renderEnd, 145);
    assert.equal(r.capped, null);
  });

  it("3분짜리 구간을 60초 배포처로 내면 60초로 잘리고 그 사실을 돌려준다", () => {
    const r = capRenderWindow(60, 0, 200);
    assert.equal(r.renderEnd, 60);
    assert.deepEqual(r.capped, { maxSec: 60, requestedSec: 200 });
  });

  it("시작이 0이 아니어도 **길이** 기준으로 자른다", () => {
    const r = capRenderWindow(60, 1200, 1493);   // 293초 — 2026-08-20 실측 사고 길이
    assert.equal(r.renderEnd - 1200, 60);
  });

  it("배속을 반영한다 — 상한은 구간이 아니라 **출력 길이**에 건다", () => {
    // 2× 빠르게: 120초 구간이 60초 출력이라 자를 필요가 없다.
    assert.equal(capRenderWindow(60, 0, 120, 2).capped, null);
    // 0.5× 느리게: 60초 구간이 120초 출력이 된다 — 구간 기준이면 못 잡는 사고다.
    const slow = capRenderWindow(60, 0, 60, 0.5);
    assert.equal(slow.capped?.requestedSec, 120);
    assert.equal(slow.renderEnd, 30);
  });

  it("프리셋이 없으면(=null·0·NaN) 종전대로 통째로 렌더한다 — 무회귀", () => {
    for (const v of [null, undefined, 0, NaN, -1]) {
      assert.equal(capRenderWindow(v as never, 0, 900).renderEnd, 900, String(v));
    }
  });

  it("이상한 배속에도 창이 뒤집히지 않는다", () => {
    for (const spd of [0, -1, NaN, undefined]) {
      const r = capRenderWindow(60, 10, 300, spd as never);
      assert.ok(r.renderEnd > 10, String(spd));
      assert.ok(r.renderEnd - 10 <= 60, String(spd));
    }
  });

  it("유튜브 숏폼 프리셋으로 자르면 출력이 60초를 절대 안 넘는다 (무작위 구간)", () => {
    const max = SHORTS_RENDER_PRESETS.youtube.maxSec;
    for (let i = 0; i < 200; i++) {
      const start = (i * 7.3) % 900;
      const len = 1 + (i * 13.7) % 900;          // 1s ~ 900s
      const spd = [0.5, 1, 1.5, 2][i % 4];
      const r = capRenderWindow(max, start, start + len, spd);
      assert.ok((r.renderEnd - start) / spd <= max + 1e-9,
        `구간 ${len}s · ${spd}× → 출력 ${(r.renderEnd - start) / spd}s`);
    }
  });
});

describe("무인 렌더는 채널 프리셋 없이 /export 를 부르지 않는다 (소스 스캔)", () => {
  // 이게 이 사고의 절반이다. 본문 없이 POST 하면 라우트가 프리셋 null → 길이 캡 비활성.
  for (const file of ["factory.ts", "automation-cycle.ts"]) {
    it(`${file} 의 export 요청이 body 로 channel 을 싣는다`, () => {
      const src = read(file);
      const at = src.indexOf("/api/clips/${clipId}/export");
      assert.notEqual(at, -1, `${file} 에서 export 호출을 못 찾았다`);
      const call = src.slice(at, at + 400);
      assert.match(call, /body:\s*JSON\.stringify\(channel \? \{ channel \} : \{\}\)/,
        `${file}: /export 요청에 channel 본문이 없다 — 프리셋 null 이면 길이 캡이 통째로 안 걸린다`);
      assert.match(call, /"content-type":\s*"application\/json"/,
        `${file}: content-type 이 없으면 Hono 의 c.req.json() 이 본문을 못 읽어 channel 이 조용히 버려진다`);
    });

    it(`${file} 이 대상 채널을 autoRenderChannel 로 정한다`, () => {
      assert.match(read(file), /autoRenderChannel\(/,
        `${file}: 채널 키를 손으로 적으면 index.ts 프리셋 표와 갈라진다`);
    });
  }

  it("/export 라우트가 그 헬퍼를 실제로 쓴다 — 산수가 두 벌이 되면 테스트가 헛돈다", () => {
    assert.match(read("index.ts"), /capRenderWindow\(preset\?\.maxSec, renderStart, renderEnd, spd\)/,
      "index.ts 의 export 라우트가 capRenderWindow 를 쓰지 않는다");
  });

  it("두 무인 경로 모두 채택 단계에서 길이 상한을 본다", () => {
    for (const file of ["factory.ts", "automation-cycle.ts"]) {
      assert.match(read(file), /shortformSegmentTooLong\(/,
        `${file}: 채택 게이트가 없으면 3분짜리가 세로로 채택돼 렌더에서 60초로 잘린다 `
        + "— 그건 숏폼이 아니라 머리만 남은 롱폼이다");
    }
  });

  // 게이트가 "가로" 로 본 추천을 채택이 "세로" 로 만들면 상한이 그대로 새 나간다.
  // 두 자리가 **같은 함수**를 부르는지 소스로 고정한다.
  it("factory: 길이 게이트와 채택이 factoryAspect 한 벌을 본다", () => {
    const src = read("factory.ts");
    assert.match(src, /shortformSegmentTooLong\(factoryAspect\(r\)/);
    assert.match(src, /aspectRatio: factoryAspect\(rec\)/);
    // 판정식 리터럴은 factoryAspect 정의 **한 곳**에만 있어야 한다.
    assert.equal([...src.matchAll(/kind === "short" \? "9:16-crop-main" : "16:9"/g)].length, 1,
      "화면비 판정이 아직 두 벌이다 — factoryAspect 로 모을 것");
  });

  it("자동배포: 길이 게이트와 채택이 adoptAspect 한 벌을 본다", () => {
    const src = read("automation-cycle.ts");
    assert.match(src, /shortformSegmentTooLong\(\s*adoptAspect\(rule, r\)/);
    assert.match(src, /const aspectRatio = adoptAspect\(rule, rec\);/);
  });

  it("factoryAspect — 숏폼만 세로", () => {
    assert.equal(factoryAspect({ kind: "short" }), "9:16-crop-main");
    for (const kind of ["clip", "highlight", undefined, null]) {
      assert.equal(factoryAspect({ kind }), "16:9", String(kind));
    }
  });
});
