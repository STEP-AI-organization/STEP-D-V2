/**
 * 예약 업로드의 **리드 타임** — 슬롯 시각은 "올리기 시작하는 시각"이 아니라
 * **"이미 올라가 있는 시각"** 이다.
 *
 * 사용자 2026-09-03: *"private 라도 5분 일찍 올려서 6시에는 편집자가 '올라갔구나' 확인하길
 * 바라는 마음."* 실측으로 확인한 것: ENA 18:00 슬롯 2건의 잡이 `runafter=18:00` 이었고
 * 유튜브에는 아직 아무것도 없었다 — 18:00 에 편집자가 보는 건 빈 채널이다.
 *
 * ⚠️ 여기서 제일 중요한 건 **리드를 주면 안 되는 채널**이다. TikTok·Instagram 은 예약 API 가
 *    없어 **이 잡이 곧 게시**다 — 5분 일찍 쏘면 글이 5분 일찍 올라간다. 유튜브 비-public 만
 *    올려도 공개되지 않아 미리 올리는 게 안전하다. 이 구분이 무너지면 고객 채널에 예정보다
 *    이른 게시가 나간다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatch = fs.readFileSync(path.join(SRC, "publish/publish-dispatch.ts"), "utf-8");

/** `enqueue("distribution.publish", …)` 한 덩어리를 채널별로 잘라 본다. */
function blockFor(channel: string): string {
  const at = dispatch.indexOf(`channel: "${channel}"`);
  assert.ok(at > 0, `${channel} 큐잉 블록을 못 찾았다`);
  const rest = dispatch.slice(at);
  return rest.slice(0, rest.indexOf("queued.push"));
}

describe("예약 업로드 리드 타임", () => {
  it("리드가 상수로 있고 5분이다 — 쇼츠 한 편이 올라가는 시간", () => {
    assert.match(dispatch, /export const UPLOAD_LEAD_MIN = 5/);
  });

  it("**유튜브 비-public 은 리드를 받는다** — 슬롯 시각엔 이미 올라가 있어야 한다", () => {
    assert.ok(dispatch.includes("scheduleDelay(input.scheduled, reserveDate, UPLOAD_LEAD_MIN)"),
      "유튜브 예약이 리드 없이 슬롯 시각에 시작한다");
  });

  it("**TikTok·Instagram 은 리드를 받지 않는다** — 그 잡이 곧 게시다", () => {
    for (const ch of ["tiktok", "instagram"]) {
      const b = blockFor(ch);
      assert.ok(b.includes("scheduleDelay(input.scheduled, reserveDate)"),
        `${ch} 가 리드를 받고 있다 — 예정보다 일찍 게시된다`);
      assert.ok(!b.includes("UPLOAD_LEAD_MIN"), `${ch} 에 리드가 붙었다`);
    }
  });

  it("public 예약은 **유튜브 네이티브**로 간다 — 즉시 올리고 유튜브가 정시에 공개한다", () => {
    assert.ok(dispatch.includes('const nativeSchedule = input.scheduled && input.privacy === "public"'));
    assert.ok(dispatch.includes("publishAt: nativeSchedule ? reserveDate : undefined"));
  });

  it("리드 창 안이면 **지금 쏜다** — 음수 지연을 만들지 않는다", () => {
    const fn = /function scheduleDelay\([\s\S]*?\n}/.exec(dispatch)?.[0] ?? "";
    assert.ok(fn.includes("const ms = t - leadMin * 60_000 - Date.now();"));
    assert.ok(fn.includes("return ms > 0 ? { delayMs: ms } : {};"));
  });

  it("파싱 못 하는 예약 문자열은 **즉시 발행하지 않는다**", () => {
    // 예전 주석: "문자열을 그대로 넘기면 NaN 이 되어 예약이 조용히 사라지고 즉시 발행된다."
    const fn = /function scheduleDelay\([\s\S]*?\n}/.exec(dispatch)?.[0] ?? "";
    assert.ok(fn.includes("if (!Number.isFinite(t)) return {};"));
  });
});
