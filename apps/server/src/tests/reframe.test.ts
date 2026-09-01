import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  canonicalRenderedClipAspect,
  effectiveReframeState,
  fitIntervalsForPlan,
  normalizeReframePlan,
  reframeFingerprint,
  reframePlanHash,
  summarizeReframePlan,
} from "../reframe.ts";

const clip = {
  id: "c_1",
  sourceMediaId: "m_1",
  startTime: 10,
  endTime: 20,
  beatIds: [3, 2, 3],
};

describe("AI reframe contract", () => {
  it("classifies the latest rendered landscape/portrait bytes in both directions", () => {
    assert.equal(canonicalRenderedClipAspect("9:16", "16:9"), "9:16-crop-main");
    assert.equal(canonicalRenderedClipAspect("9:16", "9:16-letterbox"), "9:16-letterbox");
    assert.equal(canonicalRenderedClipAspect("16:9", "9:16-crop-main"), "16:9");
    assert.equal(canonicalRenderedClipAspect("1:1", "16:9"), "16:9");
  });

  it("fingerprints planner inputs but ignores editor overlays and Beat order", () => {
    const a = reframeFingerprint(clip);
    assert.equal(a, reframeFingerprint({ ...clip, beatIds: [2, 3], editorState: { title: "changed" } }));
    assert.notEqual(a, reframeFingerprint({ ...clip, endTime: 20.5 }));
    assert.notEqual(a, reframeFingerprint({ ...clip, sourceMediaId: "m_2" }));
  });

  it("normalizes core beats into the renderer plan and preserves tracking", () => {
    const plan = normalizeReframePlan({
      version: 1,
      mode: "ai_multi",
      scoreVersion: "vision-safety-v1",
      source: { start: 10, end: 20, width: 1920, height: 1080 },
      beats: [
        { beatId: 2, start: 15, end: 20, layout: "fit", score: 62, reasonCodes: ["TWO_PEOPLE"] },
        {
          beatId: 1, start: 10, end: 15, layout: "fill", score: 82,
          reasonCodes: ["SAFE", "SAFE"],
          tracking: [
            { t: 15, cx: 0.7, cy: 0.4, confidence: 0.8 },
            { t: 10, cx: 0.3, cy: 0.5, confidence: 0.9 },
          ],
        },
      ],
    }, { start: 10, end: 20 });

    assert.deepEqual(plan.segments.map((segment) => segment.beatId), [1, 2]);
    assert.deepEqual(plan.segments[0].tracking?.map((point) => point.t), [10, 15]);
    assert.deepEqual(plan.segments[0].reasonCodes, ["SAFE"]);
    assert.equal(reframePlanHash(plan), reframePlanHash(structuredClone(plan)));
    assert.deepEqual(summarizeReframePlan(plan), {
      overallScore: 72,
      reasonCodes: ["SAFE", "TWO_PEOPLE"],
    });
  });

  it("rejects unsafe or ambiguous planner output", () => {
    const base = {
      version: 1,
      mode: "ai_multi",
      source: { start: 10, end: 20 },
    };
    assert.throws(() => normalizeReframePlan({
      ...base,
      beats: [
        { start: 10, end: 16, layout: "fit" },
        { start: 15, end: 20, layout: "fill" },
      ],
    }), /overlap/);
    assert.throws(() => normalizeReframePlan({
      ...base,
      beats: [{ start: 10, end: 20, layout: "fill", tracking: [{ t: 12, cx: 1.2, cy: 0.5 }] }],
    }), /outside the frame/);
    assert.throws(() => normalizeReframePlan({
      ...base,
      beats: [{ start: 10, end: 20, layout: "zoom" }],
    }), /invalid layout/);
  });

  it("clamps tiny planner boundary drift to the canonical clip range", () => {
    const plan = normalizeReframePlan({
      version: 1,
      mode: "ai_multi",
      source: { start: 9.98, end: 20.02 },
      beats: [{
        start: 9.98, end: 20.02, layout: "fill",
        tracking: [{ t: 9.98, cx: 0.5, cy: 0.5 }, { t: 20.02, cx: 0.6, cy: 0.5 }],
      }],
    }, { start: 10, end: 20 });
    assert.deepEqual([plan.sourceStart, plan.sourceEnd], [10, 20]);
    assert.deepEqual([plan.segments[0].start, plan.segments[0].end], [10, 20]);
    assert.deepEqual(plan.segments[0].tracking?.map((point) => point.t), [10, 20]);
  });

  it("marks a ready plan stale when trim inputs change", () => {
    const fingerprint = reframeFingerprint(clip);
    assert.equal(effectiveReframeState({
      ...clip,
      reframe: { mode: "ai_multi", status: "ready", revision: 1, inputFingerprint: fingerprint },
    }).status, "ready");
    assert.equal(effectiveReframeState({
      ...clip,
      endTime: 19,
      reframe: { mode: "ai_multi", status: "ready", revision: 1, inputFingerprint: fingerprint },
    }).status, "stale");
  });

  it("computes Fit windows as the complement of Fill segments", () => {
    const plan = normalizeReframePlan({
      version: 1, mode: "ai_multi", sourceStart: 10, sourceEnd: 20,
      segments: [
        { start: 10, end: 12, layout: "fit" },
        { start: 12, end: 14, layout: "fill" },
        { start: 16, end: 18, layout: "fill" },
        { start: 18, end: 20, layout: "fit" },
      ],
    });
    assert.deepEqual(fitIntervalsForPlan(plan, 11, 19), [
      { start: 0, end: 1 },
      { start: 3, end: 5 },
      { start: 7, end: 8 },
    ]);
  });
});

describe("AI reframe server wiring", () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (name: string) => fs.readFileSync(path.join(srcDir, name), "utf8");

  it("blocks export before cache lookup unless the current AI plan is ready", () => {
    const src = read("index.ts");
    const route = src.slice(src.indexOf('app.post("/api/clips/:id/export"'));
    const gate = route.indexOf('error: "reframe_not_ready"');
    const cache = route.indexOf("// Cache hit:");
    assert.ok(gate >= 0, "export must expose the reframe_not_ready error code");
    assert.ok(cache > gate, "export must validate AI readiness before serving a cached basic render");
    assert.match(route.slice(0, cache), /planHash/,
      "the render revision must include the validated plan hash");
    assert.match(route.slice(0, cache), /const aspect = reframePlan\s*\? "9:16"/,
      "AI plans must force a vertical render even for old/direct 16:9 editor state");
    assert.match(route.slice(0, cache), /renderAspect: aspect/,
      "the render revision must describe the effective forced aspect");
    assert.match(route, /canonicalRenderedClipAspect\(aspect, latest\.aspectRatio\)/,
      "the latest successful render must update classification in both directions");
    assert.match(src, /setClipReframe\(clipId, reframe, restoreAspect\)/,
      "switching back to basic must restore the pre-AI clip classification");
  });

  it("uses atomic JSONB paths and request CAS rather than whole-entity worker writes", () => {
    const db = read("db-pg.ts");
    assert.match(db, /jsonb_set\(data, '\{reframe\}'/);
    assert.match(db, /data->'reframe'->>'inputFingerprint' = \$2/);
    assert.match(db, /data->'reframe'->>'requestId' = \$3/);
    const pipeline = read("content-pipeline.ts");
    assert.doesNotMatch(pipeline.slice(0, pipeline.indexOf("async function downloadToTemp")),
      /putEntity\("clip"/,
      "reframe worker must not overwrite the full clip row");
  });
});
