/**
 * 결제 실패 알림 메일 — 자동 결제(자동 충전)가 **조치 필요 사유로 실패한 순간** 담당자에게
 * 보낸다. 화면 배너(autoTopupAlert)만으로는 사람이 결제 화면을 열기 전까지 모른다 —
 * B2B 는 담당자가 매일 들어오지 않는다.
 *
 * 원칙:
 *  1. **같은 사유 연속 실패에는 첫 번째만 보낸다** (호출부가 alert.count === 1 로 거른다).
 *     자동 충전 판정은 분석 완료마다 도는 경로라, 매번 보내면 메일함이 같은 줄로 덮여
 *     아무도 안 읽는다 — 알림이 배경음이 되는 순간 진짜 경고도 죽는다(credits.ts 와 같은 원칙).
 *  2. **수신자는 결제 알림 수신자 목록**(billing.notifyEmails · 결제 화면에서 등록)이 먼저고,
 *     비어 있으면 **자동배포 담당자**로 폴백한다(billingAlertRecipients · 2026-08-26).
 *     둘 다 없을 때만 보내지 않는다.
 *  3. **베스트 에포트.** 어떤 실패도 던지지 않는다 — 알림은 부속이고 충전 판정이 본체다.
 */
import { getAutomationSetting, getBillingNotifyEmails } from "./db-pg.ts";
import { NOTIFY_EMAIL_KEY } from "./automation.ts";
import type { AutoTopupAlert } from "./credits.ts";
import { mailConfigured, sendMail } from "./mailer.ts";

/**
 * 결제 경고 수신자 — 결제 알림 목록이 비어 있으면 **자동배포 담당자**에게 보낸다.
 *
 * 이 파일의 원칙 2("설정이 없으면 보내지 않는다")를 **경고에만** 완화한다(2026-08-26).
 * 근거: 잔액이 0 이면 순방이 통째로 멈춘다(automation-cycle 크레딧 게이트) — 그런데
 * ENA 는 결제 알림 목록이 비어 있어 500분 경고도, 소진 통지도 **아무에게도 안 갔다.**
 * "설정이 없으면 아무것도 하지 않는다" 는 **행동**(결제·게시)의 안전장치지, 이미 멈춘
 * 사실을 알리는 경고까지 침묵시키라는 뜻이 아니다 — 그 침묵이 이 리포 최빈 실패모드다.
 * 자동배포 담당자는 배포가 멈추면 가장 먼저 알아야 하는 사람이라 폴백으로 적합하다.
 */
async function billingAlertRecipients(): Promise<string[]> {
  const billing = await getBillingNotifyEmails();
  if (billing.length > 0) return billing;
  const fallback = String((await getAutomationSetting(NOTIFY_EMAIL_KEY)) ?? "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fallback) ? [fallback] : [];
}

function failureHtml(alert: AutoTopupAlert): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;">${k}</td><td style="padding:4px 0;color:#111;">${v}</td></tr>`;
  return `
  <div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;color:#111;">
    <h2 style="font-size:17px;border-bottom:2px solid #B3261E;padding-bottom:8px;color:#B3261E;">STEP-D 자동 결제 실패</h2>
    <p style="font-size:13px;line-height:1.6;">자동 결제(자동 충전)가 실패해 조치가 필요합니다. 잔액이 소진되면 새 분석이 시작되지 않습니다.</p>
    <table style="font-size:13px;border-collapse:collapse;">
      ${row("사유", alert.message)}
      ${alert.hint ? row("조치", alert.hint) : ""}
      ${alert.balance != null ? row("현재 잔액", `${alert.balance.toLocaleString("ko-KR")} 크레딧`) : ""}
      ${row("발생 시각", String(alert.lastAt).replace("T", " ").slice(0, 19))}
    </table>
    <p style="font-size:11px;color:#888;line-height:1.6;margin-top:16px;">
      결제 화면(크레딧)에서 카드·자동 충전 설정을 확인할 수 있습니다.<br/>
      이 알림은 결제 알림 수신자(없으면 자동배포 담당자)에게 발송됩니다.
    </p>
  </div>`;
}

/**
 * 잔액 사전 경고선(분). **이 선을 하향 통과하는 순간 한 번**만 메일이 간다 —
 * 발화 판정은 차감 지점(content-pipeline)이 "직전 잔액 ≥ 선 > 차감 후 잔액" 교차로 한다.
 * 충전으로 선 위로 올라갔다 다시 내려오면 또 알린다(그게 맞는 동작이다).
 * ENA 확정 스펙(2026-08-24): 500분.
 */
export const LOW_BALANCE_WARN_CREDITS = 500;

function lowBalanceHtml(balance: number): string {
  return `
  <div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;color:#111;">
    <h2 style="font-size:17px;border-bottom:2px solid #111;padding-bottom:8px;">STEP-D 잔액 안내</h2>
    <p style="font-size:13px;line-height:1.6;">
      크레딧 잔액이 <b>${LOW_BALANCE_WARN_CREDITS.toLocaleString("ko-KR")}분 아래</b>로 내려왔습니다
      — 현재 <b>${balance.toLocaleString("ko-KR")}분</b>.
    </p>
    <p style="font-size:13px;line-height:1.6;color:#5C5E63;">
      자동 재결제가 켜져 있으면 잔액 소진 시 저장 카드로 자동 결제됩니다.
      꺼져 있다면 결제 화면(크레딧)에서 미리 충전해 주세요 — 잔액이 없으면 새 분석이 시작되지 않습니다.
    </p>
    <p style="font-size:11px;color:#888;line-height:1.6;margin-top:16px;">
      이 알림은 결제 알림 수신자(없으면 자동배포 담당자)에게 발송됩니다.
    </p>
  </div>`;
}

/** 잔액 사전 경고 메일. **절대 던지지 않는다** — 알림은 부속이고 차감이 본체다. */
export async function notifyLowBalance(balance: number): Promise<void> {
  try {
    if (!mailConfigured()) return;
    const to = await billingAlertRecipients();
    if (to.length === 0) return;
    await sendMail({
      to: to.join(", "),
      subject: `[STEP-D] 크레딧 잔액 ${balance.toLocaleString("ko-KR")}분 — 충전 시점 안내`,
      html: lowBalanceHtml(balance),
    });
    console.log(`[billing-notify] 잔액 사전 경고 메일 발송 → ${to.length}명 (잔액 ${balance})`);
  } catch (e) {
    console.warn("[billing-notify] 잔액 경고 발송 실패(차감은 유효):", e instanceof Error ? e.message : e);
  }
}

/** 자동 결제 실패 메일 발송. **절대 던지지 않는다** — 실패는 로그로만 남는다. */
export async function notifyAutoTopupFailure(alert: AutoTopupAlert): Promise<void> {
  try {
    if (!mailConfigured()) return;
    const to = await billingAlertRecipients();
    if (to.length === 0) return;
    await sendMail({
      to: to.join(", "),
      subject: "[STEP-D] 자동 결제 실패 — 조치가 필요합니다",
      html: failureHtml(alert),
    });
    console.log(`[billing-notify] 자동 결제 실패 메일 발송 → ${to.length}명 (${alert.code})`);
  } catch (e) {
    console.warn("[billing-notify] 실패 메일 발송 실패(충전 판정은 유효):", e instanceof Error ? e.message : e);
  }
}

function stoppedHtml(): string {
  return `
  <div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;color:#111;">
    <h2 style="font-size:17px;border-bottom:2px solid #B3261E;padding-bottom:8px;color:#B3261E;">STEP-D 자동배포가 멈췄습니다</h2>
    <p style="font-size:13px;line-height:1.6;">
      크레딧 잔액이 <b>0</b> 이라 오늘 예정된 영상이 <b>채택도 게시도 되지 않았습니다.</b>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#5C5E63;">
      결제 화면(크레딧)에서 충전하면 <b>다음 확인(15분 이내)부터 자동으로 다시 시작</b>합니다 —
      따로 눌러야 하는 것은 없습니다. 다만 <b>회차 분석</b>은 충전만으로 시작되지 않으니,
      멈춰 있던 회차가 있으면 회차 화면에서 분석을 다시 시작해 주세요.
    </p>
    <p style="font-size:11px;color:#888;line-height:1.6;margin-top:16px;">
      이 알림은 하루 한 번만 발송됩니다. 이 알림은 결제 알림 수신자(없으면 자동배포 담당자)에게 발송됩니다.
    </p>
  </div>`;
}

/**
 * **자동배포가 크레딧 0 으로 멈췄다**는 통지 (2026-08-26).
 *
 * 잔액 0 이면 순방이 계획 평가 전에 통째로 돌아간다(automation-cycle 크레딧 게이트) —
 * 예전엔 그 사실이 실행 로그 한 줄로만 남아, 화면을 열어보지 않는 담당자에게는
 * **아무 일도 안 일어난 날과 구분되지 않았다.** 하루 20건이 도는 계정에서 이 침묵은
 * 곧 하루치 손실이다.
 *
 * 호출부(순방)가 KST 하루 한 줄 가드 안에서 부른다 — 순방은 15분마다 돌기 때문에
 * 가드 없이 부르면 하루 90여 통이 된다. 절대 던지지 않는다.
 */
export async function notifyAutomationCreditStop(): Promise<void> {
  try {
    if (!mailConfigured()) return;
    const to = await billingAlertRecipients();
    if (to.length === 0) return;
    await sendMail({
      to: to.join(", "),
      subject: "[STEP-D] 자동배포 정지 — 크레딧 잔액이 없습니다",
      html: stoppedHtml(),
    });
    console.log(`[billing-notify] 자동배포 크레딧 정지 메일 발송 → ${to.length}명`);
  } catch (e) {
    console.warn("[billing-notify] 크레딧 정지 메일 실패(순방은 유효):", e instanceof Error ? e.message : e);
  }
}
