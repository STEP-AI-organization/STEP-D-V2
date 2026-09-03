/**
 * 렌더 고장 알림 — **감지가 아니라 도달**을 지킨다.
 *
 * 2026-09-03 사고에서 감지는 이미 되고 있었다. `rule_run` 에 "렌더가 3회 실패했습니다" 가
 * 6번 적혔고, 잡 큐에는 실패가 16건 쌓였다. 그런데 리포트 메일은 **슬롯 마감(+90분)까지
 * 기다리는** 설계라 1시간 45분 동안 아무한테도 안 갔다 — 사람이 화면을 보다 발견했다.
 *
 * 그래서 여기서 지키는 건 넷이다: 연속일 때만 · 한 번만 · 성공하면 초기화 · 순방을 막지 않기.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const alert = fs.readFileSync(path.join(SRC, "publish/render-alert.ts"), "utf-8");
const cycle = fs.readFileSync(path.join(SRC, "pipeline/automation-cycle.ts"), "utf-8");

describe("렌더 고장 알림", () => {
  it("순방 끝에서 **매번** 결과를 넣는다 — 넣지 않으면 영원히 안 울린다", () => {
    assert.ok(cycle.includes("await noteRenderOutcome(report.renderFailed, report.published);"),
      "automation-cycle 이 결과를 안 넘긴다");
  });

  it("**연속** 실패일 때만 울린다 — 한 번의 실패는 재시도로 풀린다", () => {
    assert.match(alert, /export const RENDER_ALERT_STREAK = \d+/);
    assert.ok(alert.includes("if (streak < RENDER_ALERT_STREAK) return;"));
  });

  it("**성공이 한 건이라도 나오면 초기화**한다 — 다음 사고를 다시 알려야 한다", () => {
    assert.ok(alert.includes("if (published > 0 || renderFailed <= 0)"),
      "성공에도 연속 카운트가 남으면, 고친 뒤 다음 실패에 즉시 울린다");
    assert.ok(alert.includes('await setAutomationSetting(STREAK_KEY, "")'));
  });

  it("**같은 사고로 반복 발송하지 않는다** — 무시되는 알림은 없는 알림이다", () => {
    assert.match(alert, /export const RENDER_ALERT_COOLDOWN_MS/);
    assert.ok(alert.includes("if (Date.now() - sentAt < RENDER_ALERT_COOLDOWN_MS) return;"));
  });

  it("수신자는 **자동배포 리포트와 같은 목록**이다 — 두 군데로 갈리면 한쪽만 등록해 둔다", () => {
    assert.ok(alert.includes("NOTIFY_EMAIL_KEY"));
    assert.ok(!/RENDER_NOTIFY|renderNotifyEmails/.test(alert), "새 수신자 설정을 만들고 있다");
  });

  it("설정이 없으면 **조용히 건너뛴다** — 메일 미설정이 순방을 막으면 안 된다", () => {
    assert.ok(alert.includes("if (!mailConfigured()) return;"));
    assert.ok(alert.includes("if (!to.length) return;"));
  });

  it("**알림 실패가 순방을 막지 않는다** — 배포가 알림 때문에 멈추면 안 된다", () => {
    const fn = /export async function noteRenderOutcome[\s\S]*?\n}/.exec(alert)?.[0] ?? "";
    assert.ok(fn.includes("try {") && fn.includes("} catch (e) {"), "던지면 순방이 백오프를 탄다");
    assert.ok(!/throw/.test(fn), "여기서 던지면 안 된다");
  });

  it("본문이 **무엇을 보면 되는지**까지 말한다 — 원인만 알려주면 다음 수를 또 찾는다", () => {
    assert.ok(alert.includes("STEPD-Render-Server"), "렌더 PC 에서 볼 것을 안 적었다");
    assert.ok(alert.includes("운영 작업"), "어드민에서 볼 곳을 안 적었다");
  });
});
