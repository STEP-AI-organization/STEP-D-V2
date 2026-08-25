/**
 * 자동배포 완료 알림 — 실업로드가 **실제로 성공한 자리**(워커)에서 담당자 이메일로
 * 영상 제목·URL 을 보낸다.
 *
 * 원칙 셋:
 *  1. **자동 경로만 알린다** (배포 기록 origin 이 automation·factory). 사람이 버튼을 눌러
 *     보낸 것(manual·retry)은 그 사람이 이미 안다 — 알림이 소음이 된다.
 *  2. **설정이 없으면 아무것도 하지 않는다.** 담당자 이메일(NOTIFY_EMAIL_KEY)은
 *     워크스페이스당 하나, 자동배포 화면에서 넣는다. 워커는 잡의 테넌트 스코프로 돌므로
 *     (worker.ts runWithTenant) 여기서 읽는 설정은 그 잡 워크스페이스의 것이다.
 *  3. **베스트 에포트.** 게시는 이미 끝난 사실이고 메일은 부속이다 — 어떤 실패도 던지지
 *     않는다(인보이스 메일과 같은 원칙 · invoice-email.ts).
 *
 * ⚠️ 네이버 레인은 사무실 PC 에서 돌아 SMTP env 가 없다 — 네이버 게시는 아직 알림이 없다.
 */
import { getAutomationSetting } from "./db-pg.ts";
import { NOTIFY_EMAIL_KEY } from "./automation.ts";
import { mailConfigured, sendMail } from "./mailer.ts";

const AUTO_ORIGINS = new Set(["automation", "factory"]);

export interface AutoPublishNotice {
  /** 배포 기록을 가진 클립 — origin 판정과 프로그램명 표기에 쓴다. */
  clip: { programTitle?: unknown; distributions?: unknown };
  /** 실제로 올라간 제목 (워커가 업로드에 쓴 metaForChannel 결과 그대로). */
  title: string;
  channel: "youtube";
  /** 채널 계정 식별자 — 같은 클립이 여러 채널로 나갈 때 어느 행의 origin 을 볼지. */
  accountId: string;
  videoId: string;
  /** 예약 게시면 그 시각(ISO) — 문구가 "예약됨" 으로 바뀐다. */
  publishAt?: string | null;
}

/** 이 배포가 자동 경로였나 — 큐잉 시점에 dispatchPublish 가 기록한 origin 을 본다. */
export function isAutoOrigin(notice: Pick<AutoPublishNotice, "clip" | "channel" | "accountId">): boolean {
  const rows = Array.isArray(notice.clip.distributions) ? notice.clip.distributions : [];
  const row = rows.find((d: any) => d?.channel === notice.channel
    && (!d?.youtubeChannelId || String(d.youtubeChannelId) === notice.accountId)) as any;
  return AUTO_ORIGINS.has(String(row?.origin ?? ""));
}

function noticeHtml(n: AutoPublishNotice, url: string): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;">${k}</td><td style="padding:4px 0;color:#111;">${v}</td></tr>`;
  const program = String(n.clip.programTitle ?? "").trim();
  return `
  <div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;color:#111;">
    <h2 style="font-size:17px;border-bottom:2px solid #111;padding-bottom:8px;">자동배포 ${n.publishAt ? "예약" : "완료"}</h2>
    <p style="font-size:13px;line-height:1.6;">${n.publishAt ? "자동배포 규칙이 게시를 예약했습니다." : "자동배포 규칙이 영상을 게시했습니다."}</p>
    <table style="font-size:13px;border-collapse:collapse;">
      ${program ? row("프로그램", program) : ""}
      ${row("제목", n.title)}
      ${row("채널", "YouTube")}
      ${n.publishAt ? row("공개 예정", String(n.publishAt).replace("T", " ").slice(0, 16)) : ""}
      ${row("링크", `<a href="${url}">${url}</a>`)}
    </table>
    <p style="font-size:11px;color:#888;line-height:1.6;margin-top:16px;">
      이 알림은 자동배포 화면에 등록된 담당자 이메일로 발송됩니다 — 받지 않으려면 그 화면에서 이메일을 비워 주세요.
    </p>
  </div>`;
}

/**
 * 자동배포 성공 알림 발송. **절대 던지지 않는다** — 실패는 로그로만 남는다.
 * 호출 지점은 워커의 published 기록 성공 직후 하나뿐이다(중복 웹훅·재시도가 없는 자리).
 */
export async function notifyAutoPublish(n: AutoPublishNotice): Promise<void> {
  try {
    if (!mailConfigured()) return;
    if (!isAutoOrigin(n)) return;
    const to = String((await getAutomationSetting(NOTIFY_EMAIL_KEY)) ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;

    const url = `https://youtu.be/${n.videoId}`;
    await sendMail({
      to,
      // 브랜드 표기 없이 — 고객사 담당자 수신함에서 우리 제품명이 아니라 내용이 보여야 한다
      // (사용자 2026-08-25 · 자동배포 메일에서 "STEP-D" 제거).
      subject: `[자동배포 ${n.publishAt ? "예약" : "완료"}] ${n.title}`,
      html: noticeHtml(n, url),
    });
    console.log(`[notify] 자동배포 알림 발송 → ${to} (${n.videoId})`);
  } catch (e) {
    console.warn(`[notify] 자동배포 알림 실패 (${n.videoId}):`, e instanceof Error ? e.message : e);
  }
}
