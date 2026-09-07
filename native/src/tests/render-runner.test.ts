/**
 * 로컬 렌더 — **못 구울 때 안 굽는가.**
 *
 * 로컬 렌더의 위험은 실패가 아니다. 실패는 서버 렌더로 떨어지면 그만이다. 위험한 건
 * **반쯤 성공**이다 — 자막이나 오버레이만 빠진 영상은 ffmpeg 가 멀쩡히 만들어 내고,
 * 배포까지 그대로 간다. 아무도 에러를 못 보고 결과물만 다르다.
 *
 * 그래서 여기서 보는 것은 대부분 "안 했는가" 다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RenderPlan } from "../../../apps/server/src/media/render-plan.js";
import {
  type MaterializeDeps, materialize, pickSource, renderFromPlan,
} from "../render/runner.js";

const PLAN: RenderPlan = {
  clipId: "clip_1", revision: "rev_1", clipMediaId: "med_clip",
  output: { objectPath: "clips/med_clip.mp4" },
  source: { mediaId: "med_src", filename: "본방.mp4", size: 1_234_567, durationSec: 3600 },
  render: {
    startTime: 10, endTime: 40, width: 1080, height: 1920,
    frame: null, hookPreroll: null, badge: null,
  },
  assets: {
    ass: "[Script Info]", captionAss: null, decorationAss: null, hookCaptionAss: null,
    overlayPngUrl: "https://x/o.png", framePngUrl: null, badgePngUrl: null, hookTtsUrl: null,
  },
};

/** 시험용 바깥것 — 디스크도 네트워크도 안 쓴다. */
function deps(over: Partial<MaterializeDeps> = {}) {
  const wrote: string[] = [];
  const got: string[] = [];
  const d: MaterializeDeps = {
    join: (...p) => p.join("/"),
    writeText: async (p) => { wrote.push(p); },
    download: async (u, p) => { got.push(`${u} -> ${p}`); },
    ...over,
  };
  return { d, wrote, got };
}

describe("원본 고르기 — 이름이 아니라 크기다", () => {
  const c = (path: string, size: number) => ({ path, size });

  it("**크기가 같은 것만 고른다** — 이름만 보면 다른 회차를 굽는다", () => {
    const found = pickSource(
      [c("D:/WS/1회/source/본방.mp4", 999), c("D:/WS/2회/source/본방.mp4", 1_234_567)],
      PLAN.source);
    assert.equal(found, "D:/WS/2회/source/본방.mp4");
  });

  it("크기를 모르면 안 고른다 — 찍어서 맞히느니 서버가 굽는다", () => {
    assert.equal(pickSource([c("D:/a.mp4", 100)], { filename: "a.mp4", size: null }), null);
    assert.equal(pickSource([c("D:/a.mp4", 100)], { filename: "a.mp4", size: 0 }), null);
  });

  it("맞는 게 없으면 null", () => {
    assert.equal(pickSource([c("D:/a.mp4", 1)], PLAN.source), null);
    assert.equal(pickSource([], PLAN.source), null);
  });

  it("크기가 같은 게 여럿이면 이름으로 가른다", () => {
    const found = pickSource(
      [c("D:/WS/x/다른것.mp4", 1_234_567), c("D:/WS/y/본방.mp4", 1_234_567)], PLAN.source);
    assert.equal(found, "D:/WS/y/본방.mp4");
  });

  it("이름까지 같은 게 여럿이면 **안 고른다** — 둘 중 하나를 찍으면 절반은 틀린다", () => {
    const found = pickSource(
      [c("D:/WS/1회/source/본방.mp4", 1_234_567), c("D:/WS/2회/source/본방.mp4", 1_234_567)],
      PLAN.source);
    assert.equal(found, null);
  });

  it("한글 파일명이 자모로 쪼개져 와도 같은 것으로 본다 (macOS 를 거친 파일)", () => {
    const nfd = "본방.mp4".normalize("NFD");
    assert.notEqual(nfd, "본방.mp4", "표본이 이미 NFC 다");
    const found = pickSource(
      [c(`D:/WS/x/${nfd}`, 1_234_567), c("D:/WS/y/다른것.mp4", 1_234_567)], PLAN.source);
    assert.equal(found, `D:/WS/x/${nfd}`);
  });
});

describe("자산 되살리기", () => {
  it("본문은 파일로 쓰고 URL 은 내려받는다", async () => {
    const { d, wrote, got } = deps();
    const have = await materialize(PLAN, "T", d);
    assert.deepEqual(wrote, ["T/burn.ass"]);
    assert.deepEqual(got, ["https://x/o.png -> T/overlay.png"]);
    assert.equal(have.ass, "T/burn.ass");
    assert.equal(have.overlayPng, "T/overlay.png");
  });

  it("없는 자산은 건드리지 않는다 — 빈 파일을 만들면 ffmpeg 가 그걸 연다", async () => {
    const { d, wrote, got } = deps();
    const have = await materialize(PLAN, "T", d);
    assert.equal(have.captionAss, undefined);
    assert.equal(have.badgePng, undefined);
    assert.equal(wrote.length + got.length, 2, "안 시킨 자산까지 만들었다");
  });

  it("하나가 실패해도 던지지 않는다 — 무엇이 빠졌는지 한 번에 말하려고", async () => {
    const { d } = deps({ download: async () => { throw new Error("네트워크"); } });
    const have = await materialize(PLAN, "T", d);
    assert.equal(have.ass, "T/burn.ass", "성공한 것까지 버렸다");
    assert.equal(have.overlayPng, undefined);
  });
});

describe("굽기 — 못 구울 땐 안 굽는다", () => {
  /** renderShort 를 대신하는 감시자. 불렸는지, 무엇으로 불렸는지 본다. */
  function spy() {
    const calls: unknown[] = [];
    const fn = (async (o: unknown) => { calls.push(o); }) as never;
    return { fn, calls };
  }

  it("원본을 못 찾았으면 **ffmpeg 를 부르지 않는다**", async () => {
    const { d } = deps();
    const r = spy();
    const out = await renderFromPlan({
      plan: PLAN, inputPath: null, outputPath: "T/out.mp4", assetDir: "T", deps: d, render: r.fn });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "no_source");
    assert.equal(r.calls.length, 0, "원본 없이 ffmpeg 를 불렀다");
  });

  it("**자산이 빠지면 안 굽는다** — 구우면 오버레이만 없는 영상이 그대로 배포된다", async () => {
    const { d } = deps({ download: async () => { throw new Error("404"); } });
    const r = spy();
    const out = await renderFromPlan({
      plan: PLAN, inputPath: "D:/in.mp4", outputPath: "T/out.mp4", assetDir: "T", deps: d, render: r.fn });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "missing_assets");
    assert.match(out.ok === false ? out.detail : "", /overlayPng/);
    assert.equal(r.calls.length, 0, "자산이 빠졌는데 구웠다");
  });

  it("다 갖추면 **서버와 같은 값**으로 굽는다", async () => {
    const { d } = deps();
    const r = spy();
    const out = await renderFromPlan({
      plan: PLAN, inputPath: "D:/WS/1회/source/본방.mp4", outputPath: "T/out.mp4",
      assetDir: "T", deps: d, render: r.fn });

    assert.equal(out.ok, true);
    assert.equal(r.calls.length, 1);
    const opts = r.calls[0] as Record<string, unknown>;
    // 계획이 정한 값이 그대로 가야 한다 — 여기서 보정하면 그게 두 번째 결정이 된다.
    assert.equal(opts.startTime, 10);
    assert.equal(opts.endTime, 40);
    assert.equal(opts.width, 1080);
    assert.equal(opts.inputPath, "D:/WS/1회/source/본방.mp4");
    assert.equal(opts.assPath, "T/burn.ass");
    assert.equal(opts.overlayPngPath, "T/overlay.png");
  });

  it("ffmpeg 가 죽어도 **던지지 않는다** — 호출부가 서버 렌더로 넘길 수 있어야 한다", async () => {
    const { d } = deps();
    const out = await renderFromPlan({
      plan: PLAN, inputPath: "D:/in.mp4", outputPath: "T/out.mp4", assetDir: "T", deps: d,
      render: (async () => { throw new Error("ffmpeg exited 1"); }) as never });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "render_failed");
    assert.match(out.ok === false ? out.detail : "", /ffmpeg exited 1/);
  });
});
