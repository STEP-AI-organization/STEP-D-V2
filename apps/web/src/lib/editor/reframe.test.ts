import assert from "node:assert/strict";
import test from "node:test";
import type { ClipReframe } from "@/lib/types";
import { resolvePendingTrimReframe, sampleReframeFrame, sampleReframeTracking } from "./reframe";

test("tracking interpolation uses master-absolute time and normalized coordinates", () => {
  const focus = sampleReframeTracking([
    { t: 100, cx: 0.2, cy: 0.4 },
    { t: 102, cx: 0.8, cy: 0.6 },
  ], 101);
  assert.deepEqual(focus, { cx: 0.5, cy: 0.5 });
});

test("tracking clamps defensive out-of-range coordinates", () => {
  assert.deepEqual(sampleReframeTracking([{ t: 1, cx: -2, cy: 3 }], 1), { cx: 0, cy: 1 });
});

test("ready plan samples the Beat decision and tracking path", () => {
  const reframe: ClipReframe = {
    mode: "ai_multi",
    status: "ready",
    plan: {
      version: 1,
      mode: "ai_multi",
      sourceStart: 10,
      sourceEnd: 14,
      segments: [
        { beatId: 1, start: 10, end: 12, layout: "fit", score: 35 },
        {
          beatId: 2,
          start: 12,
          end: 14,
          layout: "fill",
          score: 88,
          tracking: [{ t: 12, cx: 0.25, cy: 0.5 }, { t: 14, cx: 0.75, cy: 0.5 }],
        },
      ],
    },
  };
  const frame = sampleReframeFrame(reframe, 13);
  assert.equal(frame.layout, "fill");
  assert.equal(frame.segment?.beatId, 2);
  assert.deepEqual({ cx: frame.cx, cy: frame.cy }, { cx: 0.5, cy: 0.5 });
});

test("non-ready AI state never previews an unvalidated Fill", () => {
  const frame = sampleReframeFrame({ mode: "ai_multi", status: "running" }, 20);
  assert.deepEqual(frame, { layout: "fit", cx: 0.5, cy: 0.5 });
});

test("an expired trim re-analysis waits for the active request, then runs", () => {
  const pending = { key: "clip-1:10.000:20.000", dueAt: 1_000 };
  assert.equal(resolvePendingTrimReframe(pending, pending.key, true, true, 1_500), "wait");
  assert.equal(resolvePendingTrimReframe(pending, pending.key, true, false, 1_500), "run");
});

test("trim re-analysis drops when the clip/trim changed or Basic mode won", () => {
  const pending = { key: "clip-1:10.000:20.000", dueAt: 1_000 };
  assert.equal(resolvePendingTrimReframe(pending, "clip-2:1.000:2.000", true, false, 1_500), "drop");
  assert.equal(resolvePendingTrimReframe(pending, pending.key, false, false, 1_500), "drop");
});
