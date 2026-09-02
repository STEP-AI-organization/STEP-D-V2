/**
 * 배치(aspect) → 프레임 영상창 변환.
 *
 * 이 파일이 지키는 건 **무회귀**다: 배치를 명시하지 않은 계획·수동 편집분은 지금까지대로
 * 템플릿 창을 써야 한다. 그래서 "모르는 값이면 null" 이 기능 자체보다 중요한 성질이다 —
 * 여기서 기본값을 만들면 이미 돌던 계획의 결과물이 조용히 바뀐다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ASPECT_PRESETS } from "../media/aspect-presets.ts";
import { bandsAroundVideo, frameVideoForAspect } from "../media/aspect-frame.ts";

const W = 1080, H = 1920;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("모르는 배치·미지정이면 null — 템플릿 창을 그대로 쓴다(무회귀)", () => {
  for (const v of [undefined, null, "", "9:16", "9:16-crop", "nope", 0, {}]) {
    assert.equal(frameVideoForAspect(v, W, H), null, `null 이어야 한다: ${JSON.stringify(v)}`);
  }
});

test("가로(16:9)는 영상창을 잡지 않는다", () => {
  // 캔버스 자체가 가로라 잘라 앉힐 창이 없다. orientation 이 이미 정하는 축이다.
  assert.equal(frameVideoForAspect("16:9", 1920, 1080), null);
});

test("전체 담기 = 캔버스 전체에 contain(레터박스)", () => {
  assert.deepEqual(frameVideoForAspect("9:16-letterbox", W, H), { x: 0, y: 0, w: W, h: H, fit: "contain" });
});

test("꽉 채우기 = 캔버스 전체에 cover", () => {
  assert.deepEqual(frameVideoForAspect("9:16-crop-full", W, H), { x: 0, y: 0, w: W, h: H, fit: "cover" });
});

test("띠 배치는 프리셋 rect 를 그대로 쓴다 — 편집기와 같은 자리", () => {
  for (const id of ["9:16-crop-main", "9:16-crop-sub"]) {
    const p = ASPECT_PRESETS.find((x) => x.id === id)!;
    const got = frameVideoForAspect(id, W, H)!;
    assert.deepEqual(got, { x: p.rect!.x, y: p.rect!.y, w: p.rect!.w, h: p.rect!.h, fit: "cover" });
  }
});

test("캔버스가 프리셋 기준(1080×1920)과 다르면 비율로 옮긴다", () => {
  const got = frameVideoForAspect("9:16-crop-main", 540, 960)!;
  const p = ASPECT_PRESETS.find((x) => x.id === "9:16-crop-main")!;
  assert.equal(got.y, Math.round(p.rect!.y / 2));
  assert.equal(got.h, Math.round(p.rect!.h / 2));
  assert.equal(got.w, 540);
});

test("밴드는 영상창의 위·아래 나머지 — 꽉 차면 없다", () => {
  assert.deepEqual(bandsAroundVideo({ y: 0, h: H }, W, H), []);
  const b = bandsAroundVideo({ y: 440, h: 1480 }, W, H, "black");
  assert.equal(b.length, 1);            // 아래가 캔버스 끝에 닿는다(440+1480=1920)
  assert.deepEqual(b[0], { x: 0, y: 0, w: W, h: 440, color: "black" });
  const two = bandsAroundVideo({ y: 440, h: 980 }, W, H, "black");
  assert.equal(two.length, 2);
  assert.deepEqual(two[1], { x: 0, y: 1420, w: W, h: 500, color: "black" });
});

test("순방은 rule.aspect 로만 videoAspect 를 싣는다 — 기본 폴백으로 만들지 않는다", () => {
  // aspectRatio 는 미지정 계획에도 SHORTS_DEFAULT_ASPECT 로 채워진다. 그걸로 실으면
  // 배치를 고른 적 없는 계획의 영상창이 템플릿에서 배치로 바뀌어 결과물이 달라진다.
  const src = fs.readFileSync(path.join(SRC, "pipeline", "automation-cycle.ts"), "utf-8");
  assert.match(src, /rule\.aspect \? \{ videoAspect: rule\.aspect \} : \{\}/,
    "videoAspect 가 rule.aspect 조건부로 실리지 않는다 — 무회귀가 깨진다");
  assert.doesNotMatch(src, /videoAspect: aspectRatio/,
    "기본 폴백(aspectRatio)으로 videoAspect 를 실으면 안 된다");
});

test("렌더는 videoAspect 가 있을 때만 템플릿 창을 덮는다", () => {
  const src = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
  assert.match(src, /frameVideoForAspect\(\s*\(editorState as \{ videoAspect\?: unknown \} \| null\)\?\.videoAspect/,
    "렌더가 videoAspect 를 안 본다");
  assert.match(src, /video: rectFromRule \?\? tpl\.video/,
    "배치가 없을 때 템플릿 창으로 떨어지지 않는다");
});
