import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  hasFfmpeg,
  normalizeReframeSegments,
  probe,
  renderShort,
  trackingAxisExpression,
  type ReframeRenderPlan,
} from "./ffmpeg.ts";

describe("AI beat reframe renderer", () => {
  it("sorts/clamps the plan and fills every uncovered range with fit", () => {
    const plan: ReframeRenderPlan = {
      version: 1,
      mode: "ai_multi",
      segments: [
        { start: 12, end: 15, layout: "fill", tracking: [{ t: 13, cx: 1.4, cy: -1 }] },
        { start: 8, end: 11, layout: "fit" },
        { start: Number.NaN, end: 20, layout: "fill" },
      ],
    };
    const got = normalizeReframeSegments(plan, 10, 16);
    assert.deepEqual(got.map((x) => [x.start, x.end, x.layout]), [
      [10, 11, "fit"],
      [11, 12, "fit"],
      [12, 15, "fill"],
      [15, 16, "fit"],
    ]);
    assert.equal(got[2].tracking[0].cx, 1);
    assert.equal(got[2].tracking[0].cy, 0);
  });

  it("accepts beat-shaped plans and builds bounded piecewise tracking", () => {
    const plan: ReframeRenderPlan = {
      version: 1,
      mode: "ai_multi",
      beats: [{
        beatId: "b1", start: 20, end: 22, layout: "fill",
        tracking: [
          { t: 20, cx: 0.2, cy: 0.5 },
          { t: 21, cx: 0.8, cy: 0.5 },
          { t: 22, cx: 0.6, cy: 0.5 },
        ],
      }],
    };
    const [beat] = normalizeReframeSegments(plan, 20, 22);
    const expr = trackingAxisExpression(beat.tracking, "cx", beat.start);
    assert.match(expr, /clip\(\(t-0\)\/1,0,1\)/);
    assert.match(expr, /if\(lt\(t,1\)/);
    assert.equal(trackingAxisExpression([], "cy", 20), "0.5");
  });

  it("renders a fit-fill-fit synthetic clip with audio and target dimensions", {
    skip: !hasFfmpeg(),
  }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepd-rf-"));
    const input = path.join(dir, "input.mp4");
    const output = path.join(dir, "output.mp4");
    const hookOutput = path.join(dir, "output-hook.mp4");
    try {
      execFileSync("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "color=c=red:size=160x180:rate=30:duration=4",
        "-f", "lavfi", "-i", "color=c=blue:size=160x180:rate=30:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]",
        "-map", "[v]", "-map", "2:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input,
      ], { stdio: "ignore", timeout: 30_000 });
      const plan: ReframeRenderPlan = {
        version: 1,
        mode: "ai_multi",
        segments: [
          { start: 0, end: 1, layout: "fit" },
          {
            start: 1, end: 3, layout: "fill",
            tracking: [
              { t: 1, cx: 0.2, cy: 0.5 },
              { t: 3, cx: 0.8, cy: 0.5 },
            ],
          },
          { start: 3, end: 4, layout: "fit" },
        ],
      };
      await renderShort({
        inputPath: input,
        startTime: 0,
        endTime: 4,
        outputPath: output,
        width: 108,
        height: 192,
        bgType: "solid",
        bgColor: "#000000",
        reframePlan: plan,
      });
      const meta = await probe(output);
      assert.equal(meta.width, 108);
      assert.equal(meta.height, 192);
      assert.equal(meta.hasAudio, true);
      assert.ok(meta.durationSec > 3.8 && meta.durationSec < 4.2, `duration=${meta.durationSec}`);

      const sampleCenter = (t: number): Buffer => execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", output,
        "-frames:v", "1", "-vf", "crop=1:1:54:96,format=rgb24", "-f", "rawvideo", "pipe:1",
      ], { timeout: 30_000 });
      const leftFocus = sampleCenter(1.15);
      const rightFocus = sampleCenter(2.85);
      assert.ok(leftFocus[0] > leftFocus[2] + 100, `left focus rgb=${[...leftFocus.subarray(0, 3)]}`);
      assert.ok(rightFocus[2] > rightFocus[0] + 100, `right focus rgb=${[...rightFocus.subarray(0, 3)]}`);

      await renderShort({
        inputPath: input,
        startTime: 0,
        endTime: 4,
        outputPath: hookOutput,
        width: 108,
        height: 192,
        bgType: "solid",
        reframePlan: plan,
        hookPreroll: { startTime: 0.5, durationSec: 0.75, hasAudio: true },
      });
      const hookMeta = await probe(hookOutput);
      assert.equal(hookMeta.width, 108);
      assert.equal(hookMeta.height, 192);
      assert.equal(hookMeta.hasAudio, true);
      assert.ok(hookMeta.durationSec > 4.35 && hookMeta.durationSec < 4.65, `hook duration=${hookMeta.durationSec}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
