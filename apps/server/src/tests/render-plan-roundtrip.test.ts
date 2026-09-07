/**
 * 렌더 계획 **왕복이 무손실인가.**
 *
 * 로컬 렌더의 약속은 "편집자 PC 가 구운 것과 서버가 구운 것이 같다" 이고, 그 약속이
 * 실제로 걸린 지점은 딱 하나다 — 서버의 `RenderShortOpts` 가 JSON(`RenderPlan`)을
 * 거쳐 편집자 PC 에서 다시 `RenderShortOpts` 로 조립될 때 **값이 하나도 안 변하는가.**
 *
 * 변하면 아무도 에러를 못 본다. ffmpeg 는 멀쩡히 돌고, 배포도 되고, 결과 영상만
 * 다르다. 그래서 여기서 ffmpeg 없이 값만으로 증명한다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RenderShortOpts } from "../media/ffmpeg.ts";
import {
  type RenderPlan, missingAssets, planToRenderOpts,
} from "../media/render-plan.ts";

/** 서버가 실제로 만드는 것 중 **가장 복잡한 모양** — 프레임·프리롤·배지·리프레임이 전부 있다. */
const FULL: RenderShortOpts = {
  inputPath: "/tmp/master.mp4",
  outputPath: "/tmp/out.mp4",
  startTime: 12.5, endTime: 47.25,
  width: 1080, height: 1920,
  assPath: "/tmp/a.ass",
  captionAssPath: "/tmp/c.ass",
  decorationAssPath: "/tmp/d.ass",
  overlayPngPath: "/tmp/o.png",
  videoFilters: "eq=contrast=1.20,colorbalance=rm=0.15",
  audioFilter: "volume=0.500,atempo=1.05",
  speed: 1.05,
  bgType: "solid",
  bgColor: "#0E0E12",
  fit: "cover",
  cropRect: { x: 0, y: 240, w: 1080, h: 1440 },
  frame: {
    overlayPath: "/tmp/frame.png",
    video: { x: 0, y: 420, w: 1080, h: 1080, fit: "cover" },
    bands: [{ x: 0, y: 0, w: 1080, h: 420, color: "#111318", over: true }],
    overlayRegions: [{ x: 0, y: 1500, w: 1080, h: 420 }],
  },
  hookPreroll: {
    startTime: 13.0, durationSec: 3, hasAudio: true,
    ttsPath: "/tmp/hook.mp3", captionAssPath: "/tmp/hookcap.ass",
  },
  badge: { path: "/tmp/badge.png", y: 1720, h: 72, x: 404 },
  reframePlan: {
    version: 1,
    mode: "ai_multi",
    sourceStart: 12.5,
    sourceEnd: 47.25,
    segments: [{ start: 12.5, end: 30, layout: "fill", score: 0.82, reasonCodes: ["face"] }],
  },
};

/** 서버 라우트가 하는 직렬화를 값만 흉내 낸다(파일 읽기·업로드 제외). */
function serialize(o: RenderShortOpts): RenderPlan {
  return {
    clipId: "clip_1", revision: "rev_abc", clipMediaId: "med_1",
    output: { objectPath: "clips/med_1.mp4" },
    source: { mediaId: "med_src", filename: "본방.mp4", size: 123, durationSec: 3600 },
    render: {
      startTime: o.startTime, endTime: o.endTime, width: o.width, height: o.height,
      videoFilters: o.videoFilters, audioFilter: o.audioFilter, speed: o.speed,
      bgType: o.bgType, bgColor: o.bgColor, fit: o.fit, cropRect: o.cropRect,
      frame: o.frame
        ? { video: o.frame.video, bands: o.frame.bands, overlayRegions: o.frame.overlayRegions }
        : null,
      reframePlan: o.reframePlan,
      hookPreroll: o.hookPreroll
        ? { startTime: o.hookPreroll.startTime, durationSec: o.hookPreroll.durationSec,
            hasAudio: o.hookPreroll.hasAudio }
        : null,
      badge: o.badge ? { y: o.badge.y, h: o.badge.h, x: o.badge.x } : null,
    },
    assets: {
      ass: o.assPath ? "[Script Info]" : null,
      captionAss: o.captionAssPath ? "[Script Info]" : null,
      decorationAss: o.decorationAssPath ? "[Script Info]" : null,
      hookCaptionAss: o.hookPreroll?.captionAssPath ? "[Script Info]" : null,
      overlayPngUrl: o.overlayPngPath ? "https://x/o.png" : null,
      framePngUrl: o.frame?.overlayPath ? "https://x/f.png" : null,
      badgePngUrl: o.badge?.path ? "https://x/b.png" : null,
      hookTtsUrl: o.hookPreroll?.ttsPath ? "https://x/h.mp3" : null,
    },
  };
}

/** 편집자 PC 가 자산을 되살린 뒤의 경로들. */
const LOCAL = {
  inputPath: "D:/WS/프로그램/1회/source/본방.mp4",
  outputPath: "D:/WS/.tmp/out.mp4",
  ass: "D:/WS/.tmp/a.ass", captionAss: "D:/WS/.tmp/c.ass",
  decorationAss: "D:/WS/.tmp/d.ass", hookCaptionAss: "D:/WS/.tmp/hookcap.ass",
  overlayPng: "D:/WS/.tmp/o.png", framePng: "D:/WS/.tmp/f.png",
  badgePng: "D:/WS/.tmp/b.png", hookTts: "D:/WS/.tmp/h.mp3",
};

/** 경로 필드를 로컬 것으로 바꾼 "정답" — 나머지는 전부 원본과 같아야 한다. */
function expected(): RenderShortOpts {
  return {
    ...FULL,
    inputPath: LOCAL.inputPath, outputPath: LOCAL.outputPath,
    assPath: LOCAL.ass, captionAssPath: LOCAL.captionAss, decorationAssPath: LOCAL.decorationAss,
    overlayPngPath: LOCAL.overlayPng,
    frame: { ...FULL.frame!, overlayPath: LOCAL.framePng },
    badge: { ...FULL.badge!, path: LOCAL.badgePng },
    hookPreroll: { ...FULL.hookPreroll!, ttsPath: LOCAL.hookTts, captionAssPath: LOCAL.hookCaptionAss },
  };
}

describe("렌더 계획 왕복", () => {
  it("**JSON 을 건너도 값이 하나도 안 변한다** — 경로만 로컬 것으로 바뀐다", () => {
    // 실제 경로를 그대로 밟는다: 직렬화 → JSON 문자열 → 파싱 → 조립.
    // JSON.stringify 는 undefined 키를 지우므로, 그 손실까지 여기서 드러난다.
    const plan: RenderPlan = JSON.parse(JSON.stringify(serialize(FULL)));
    const back = planToRenderOpts(plan, LOCAL);
    assert.deepEqual(back, expected());
  });

  it("가장 단순한 모양도 왕복한다 — 자산이 하나도 없는 클립", () => {
    const bare: RenderShortOpts = {
      inputPath: "/tmp/m.mp4", outputPath: "/tmp/o.mp4",
      startTime: 0, endTime: 30, width: 1080, height: 1920,
    };
    const plan: RenderPlan = JSON.parse(JSON.stringify(serialize(bare)));
    const back = planToRenderOpts(plan, { inputPath: "D:/in.mp4", outputPath: "D:/out.mp4" });

    assert.equal(back.startTime, 0);
    assert.equal(back.endTime, 30);
    // 자산이 없으면 전부 null 이어야 한다 — 빈 문자열이면 ffmpeg 가 없는 파일을 연다.
    assert.equal(back.assPath, null);
    assert.equal(back.frame, null);
    assert.equal(back.badge, null);
    assert.equal(back.hookPreroll, null);
  });

  it("**그림 없는 프레임은 통째로 버린다** — 기하만 남으면 ffmpeg 가 없는 파일을 연다", () => {
    const plan = serialize(FULL);
    const back = planToRenderOpts(plan, { ...LOCAL, framePng: null, badgePng: null });
    assert.equal(back.frame, null, "PNG 없이 프레임 기하를 남겼다");
    assert.equal(back.badge, null, "PNG 없이 배지를 남겼다");
  });

  it("숫자가 문자열로 굳지 않는다 — JSON 은 타입을 안 지켜 준다", () => {
    const plan: RenderPlan = JSON.parse(JSON.stringify(serialize(FULL)));
    const back = planToRenderOpts(plan, LOCAL);
    assert.equal(typeof back.startTime, "number");
    assert.equal(typeof back.width, "number");
    assert.equal(typeof back.hookPreroll?.durationSec, "number");
    assert.equal(back.startTime, 12.5, "소수가 잘렸다");
  });
});

describe("자산 확인 — 반쪽짜리로 굽지 않는다", () => {
  it("계획이 약속한 자산을 못 받았으면 이름을 댄다", () => {
    const plan = serialize(FULL);
    const missing = missingAssets(plan, { ...LOCAL, overlayPng: null, hookTts: null });
    assert.deepEqual(missing.sort(), ["hookTts", "overlayPng"]);
  });

  it("전부 받았으면 비어 있다", () => {
    assert.deepEqual(missingAssets(serialize(FULL), LOCAL), []);
  });

  it("애초에 없는 자산은 못 받은 것이 아니다", () => {
    const bare: RenderShortOpts = {
      inputPath: "/a", outputPath: "/b", startTime: 0, endTime: 1, width: 1080, height: 1920,
    };
    assert.deepEqual(missingAssets(serialize(bare), {}), []);
  });

  /**
   * 이게 이 파일에서 제일 중요한 테스트다. 자산이 빠져도 ffmpeg 는 **성공한다** —
   * 오버레이만 없는 영상이 나오고 그대로 배포된다. 그래서 굽기 전에 막아야 한다.
   */
  it("자산이 빠진 채로 조립은 되지만, 확인이 먼저 걸러야 한다", () => {
    const plan = serialize(FULL);
    const short = planToRenderOpts(plan, { ...LOCAL, ass: null });
    assert.equal(short.assPath, null, "조립은 조용히 된다 — 그래서 확인이 필요하다");
    assert.ok(missingAssets(plan, { ...LOCAL, ass: null }).includes("ass"));
  });
});
