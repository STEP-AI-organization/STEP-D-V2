/**
 * **렌더가 계속 실패하면 사람에게 알린다** — 마감까지 기다리지 않는다.
 *
 * ## 왜 이게 필요한가 (2026-09-03 사고)
 *
 * 윈도우2 렌더 서버가 커밋 누락으로 부팅에 실패했다. 그 뒤 **1시간 45분 동안**:
 *   · 렌더 워커는 살아서 잡을 계속 집었고 → `fetch failed` 로 16건이 탔다
 *   · 순방은 그때마다 `rule_run` 에 "렌더가 3회 실패했습니다" 를 정확히 적었다
 *   · 리포트 메일은 **마감(슬롯+90분)까지 기다리므로** 아무것도 안 보냈다
 *   · 결국 사람이 화면을 보다 발견했다
 *
 * **감지는 되고 있었다. 도달만 안 했다.** 이 리포에서 제일 자주 나는 실패 방식 그대로다.
 *
 * ## 설계
 *
 * · **연속 실패**만 본다(`RENDER_ALERT_STREAK`). 한 번의 실패는 재시도로 풀리는 일이 많고,
 *   그때마다 메일을 보내면 사람이 메일을 무시하게 된다 — 무시되는 알림은 없는 알림이다.
 * · **한 번만 보낸다**(`RENDER_ALERT_COOLDOWN_MS`). 고장은 대개 몇 시간 이어지는데
 *   순방마다 보내면 같은 사고로 수십 통이 간다.
 * · 성공이 한 건이라도 나오면 **연속 카운트를 지운다** — 다음 사고를 다시 알릴 수 있어야 한다.
 * · **베스트 에포트.** 알림이 실패해도 순방은 계속돼야 한다(배포가 알림 때문에 멈추면 안 된다).
 * · 수신자는 자동배포 리포트와 **같은 목록**이다. 새 설정을 만들지 않는다 — 받을 사람이
 *   두 군데로 갈리면 한쪽만 등록해 두고 "알림이 안 온다" 가 된다.
 */
import { getAutomationSetting, setAutomationSetting } from "../db-pg.ts";
import { NOTIFY_EMAIL_KEY, parseNotifyEmails } from "../pipeline/automation.ts";
import { mailConfigured, sendMail } from "../mailer.ts";

/** 몇 번 **연속**으로 실패해야 알리나. 순방이 15분 간격이라 2회면 약 30분이다. */
export const RENDER_ALERT_STREAK = 2;
/** 같은 사고로 다시 알리기까지의 최소 간격. */
export const RENDER_ALERT_COOLDOWN_MS = 6 * 3600_000;

const STREAK_KEY = "render.alert.streak";
const SENT_AT_KEY = "render.alert.sentAt";

/**
 * 순방 한 번의 렌더 결과를 넣는다. 조건이 차면 알림을 보낸다.
 *
 * @param renderFailed 이번 순방에서 렌더가 실패한 건수
 * @param published    이번 순방에서 실제로 게시된 건수(성공 신호)
 */
export async function noteRenderOutcome(renderFailed: number, published: number): Promise<void> {
  try {
    // 게시가 하나라도 됐으면 렌더 경로는 살아 있다 — 연속 기록을 지운다.
    if (published > 0 || renderFailed <= 0) {
      if (await getAutomationSetting(STREAK_KEY)) await setAutomationSetting(STREAK_KEY, "");
      return;
    }

    const streak = Number(await getAutomationSetting(STREAK_KEY)) + 1;
    await setAutomationSetting(STREAK_KEY, String(streak));
    if (streak < RENDER_ALERT_STREAK) return;

    // 쿨다운 — 고장이 몇 시간 이어져도 한 통이면 족하다.
    const sentAt = Number(await getAutomationSetting(SENT_AT_KEY)) || 0;
    if (Date.now() - sentAt < RENDER_ALERT_COOLDOWN_MS) return;

    if (!mailConfigured()) return;                       // 메일 미설정 = 조용히 건너뜀
    const to = parseNotifyEmails(await getAutomationSetting(NOTIFY_EMAIL_KEY));
    if (!to.length) return;                              // 받을 사람이 없으면 보내지 않는다

    await sendMail({
      to: to.join(", "),
      subject: `[STEP AI] 자동배포 렌더가 계속 실패하고 있습니다 (${streak}회 연속 · ${renderFailed}건)`,
      html: alertHtml(streak, renderFailed),
    });
    await setAutomationSetting(SENT_AT_KEY, String(Date.now()));
    console.warn(`[render-alert] 렌더 연속 실패 ${streak}회 — 알림 발송 → ${to.join(", ")}`);
  } catch (e) {
    // 알림 실패가 순방을 막으면 안 된다.
    console.warn("[render-alert] 알림 처리 실패(순방은 계속):", e instanceof Error ? e.message : e);
  }
}

/**
 * 본문 — **무엇이 멈췄고 무엇을 보면 되는지**만. 원인은 여기서 단정하지 않는다
 * (윈도우2 · 렌더 서비스 · ffmpeg · 원본 접근 중 무엇이든 같은 증상이라서).
 */
function alertHtml(streak: number, failed: number): string {
  return `<div style="font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f1f1f">
  <p><b>자동배포의 렌더가 ${streak}회 연속 실패했습니다</b> (직전 순방 ${failed}건).</p>
  <p>렌더가 안 되면 예약 시각이 와도 <b>올라갈 영상이 없습니다.</b> 지금 확인해 주세요.</p>
  <ul>
    <li>어드민 → <b>운영 작업</b>: <code>clip.render</code> 실패가 쌓이고 있는지</li>
    <li>렌더 PC(윈도우2)의 <b>STEPD-Render-Server</b> 작업이 <b>Running</b> 인지</li>
    <li>같은 원인이 계속되면 자동배포는 다음 순방마다 재시도합니다 — 고치면 이어서 나갑니다.</li>
  </ul>
  <p style="color:#5f6368;font-size:12px">
    이 알림은 ${RENDER_ALERT_STREAK}회 연속 실패에서 한 번만 갑니다
    (같은 사고로 반복 발송하지 않습니다 · ${RENDER_ALERT_COOLDOWN_MS / 3600_000}시간).
    게시가 한 건이라도 성공하면 초기화됩니다.
  </p>
</div>`;
}
