/**
 * 자동배포 리포트 메일 — **영상마다 한 통이 아니라, 하루 몫이 다 나가면 묶어서 한 통**
 * (사용자 2026-08-26 · 템플릿: KT ENA 자동배포 리포트 final-normal.html).
 *
 * 흐름:
 *  1. 워커가 실업로드에 성공할 때마다 `recordAutoPublishForReport` 로 **버퍼에 적립**만 한다
 *     (automation_setting KV · 테넌트 스코프). 메일은 여기서 안 보낸다.
 *  2. 순방(automation-cycle · 15분)이 끝날 때 `maybeFlushAutoPublishReport` 가
 *     "오늘 계획 몫이 전부 나갔나"를 판정하고, 다 나갔으면 리포트 한 통을 보내고 버퍼를 비운다.
 *     확정 실패 등으로 영영 목표에 못 미치면 마감(마지막 슬롯+90분 · 활동창 끝)에 그때까지
 *     몫으로 보낸다. 지난 날짜 항목이 남아 있으면(어제 마감 후 늦게 올라간 예약분 등)
 *     다음 순방에서 즉시 보낸다 — 묶음이 하루를 넘겨 썩지 않는다.
 *
 * 원칙 (구 영상별 알림에서 계승):
 *  - **자동 경로만**(origin automation·factory). 사람이 누른 배포는 그 사람이 이미 안다.
 *  - **설정 없으면 아무것도 안 한다.** 담당자 이메일(NOTIFY_EMAIL_KEY) 없으면 적립도 안 한다.
 *  - **베스트 에포트.** 게시는 이미 끝난 사실 — 어떤 실패도 던지지 않는다.
 *
 * ⚠️ 알려진 한계(v1): 네이버 등 잡 지연 방식 예약은 업로드가 슬롯 직전이라, 목표 판정
 * (rule_run 기준)보다 적립이 늦을 수 있다 — 그 항목은 다음 리포트(지난날 즉시 발송)로 넘어간다.
 */
import {
  getAutomationSetting, setAutomationSetting, listAutomationRules, publishedTodayKst,
} from "./db-pg.ts";
import {
  NOTIFY_EMAIL_KEY, allowedToday, isPublishDay, kstMinutes, perDayCount,
  ruleChannels, ruleSlots, staleMissedSlots, type AutomationRule, type RuleSlot,
} from "./automation.ts";
import { mailConfigured, sendMail } from "./mailer.ts";

const AUTO_ORIGINS = new Set(["automation", "factory"]);
/** 적립 버퍼 KV 키 — 값은 AutoReportItem[] JSON. 테넌트 스코프(automation_setting PK). */
export const REPORT_BUFFER_KEY = "automation.report.pending";

export interface AutoPublishNotice {
  /** 배포 기록을 가진 클립 — origin 판정과 프로그램명·길이 표기에 쓴다. */
  clip: { programTitle?: unknown; durationSec?: unknown; distributions?: unknown };
  /** 실제로 올라간 제목 (워커가 업로드에 쓴 metaForChannel 결과 그대로). */
  title: string;
  channel: "youtube";
  /** 채널 계정 식별자 — 같은 클립이 여러 채널로 나갈 때 어느 행의 origin 을 볼지. */
  accountId: string;
  /** 사람이 읽는 채널 이름 (없으면 accountId). */
  channelLabel?: string;
  videoId: string;
  /** 예약 게시면 그 시각(ISO) — 리포트에 '예약' 으로 표기된다. */
  publishAt?: string | null;
  /** 클립 식별자 — 같은 클립의 앞선 **실패 적립을 성공이 지우는** 축(재시도 성공 시). */
  clipId?: string;
}

/** 이 배포가 자동 경로였나 — 큐잉 시점에 dispatchPublish 가 기록한 origin 을 본다. */
export function isAutoOrigin(notice: Pick<AutoPublishNotice, "clip" | "channel" | "accountId">): boolean {
  const rows = Array.isArray(notice.clip.distributions) ? notice.clip.distributions : [];
  const row = rows.find((d: any) => d?.channel === notice.channel
    && (!d?.youtubeChannelId || String(d.youtubeChannelId) === notice.accountId)) as any;
  return AUTO_ORIGINS.has(String(row?.origin ?? ""));
}

/** 리포트 한 줄 — 버퍼에 저장되는 형태. date 는 KST 달력일(하루 넘김 판정 축). */
export interface AutoReportItem {
  date: string;             // "2026-08-26" (KST)
  title: string;
  program: string;
  channelLabel: string;
  videoId: string;
  url: string;
  durationSec: number | null;
  publishedAtMs: number;
  publishAt: string | null; // ISO — 있으면 '예약'
  /** 실패 항목 — '게시' 가 아니라 '확인 필요' 로 집계되고 재시도 안내가 붙는다 (2026-08-26). */
  failed?: boolean;
  /** 실패 사유 — 워커가 배포 행에 남긴 사람 말 그대로. */
  error?: string;
  /** 실패 dedupe·성공 시 제거 축 — 같은 (클립·채널·계정) 실패가 재시도마다 안 쌓이게. */
  clipId?: string;
  accountKey?: string;
}

const kstDate = (at: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const kstHm = (at: Date): string =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
const KST_WD = ["일", "월", "화", "수", "목", "금", "토"];
function kstMdw(at: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" })
    .formatToParts(at);
  const m = p.find((x) => x.type === "month")?.value ?? "";
  const d = p.find((x) => x.type === "day")?.value ?? "";
  const w = new Date(at.toLocaleString("en-US", { timeZone: "Asia/Seoul" })).getDay();
  return `${m}/${d}(${KST_WD[w]})`;
}
const fmtDur = (sec: number | null): string | null => {
  if (!Number.isFinite(sec as number) || (sec as number) <= 0) return null;
  const s = Math.round(sec as number);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

async function notifyEmail(): Promise<string | null> {
  const to = String((await getAutomationSetting(NOTIFY_EMAIL_KEY)) ?? "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) ? to : null;
}

async function readBuffer(): Promise<AutoReportItem[]> {
  try {
    const raw = await getAutomationSetting(REPORT_BUFFER_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/**
 * 게시 1건 적립. **절대 던지지 않는다.** 호출 지점은 워커의 published 기록 성공 직후 하나뿐.
 * (동시 드레인 두 개가 겹치면 이 read-modify-write 가 드물게 한 건을 잃을 수 있다 —
 *  리포트는 부속 기록이라 감수한다. 배포 상태의 정본은 distributions 행이다.)
 */
export async function recordAutoPublishForReport(n: AutoPublishNotice): Promise<void> {
  try {
    if (!mailConfigured()) return;
    if (!(await notifyEmail())) return;   // 담당자 이메일 없으면 적립도 안 한다(버퍼 무한성장 방지)
    if (!isAutoOrigin(n)) return;
    const accountKey = `${n.channel}:${n.accountId}`;
    // 같은 (클립·채널) 의 **앞선 실패 항목을 지운다** — 재시도가 성공했는데도 리포트가
    // "확인 필요" 로 남으면 담당자가 이미 나간 영상을 다시 손댄다(2026-08-26).
    const items = (await readBuffer())
      .filter((i) => !(i.failed && i.clipId && i.clipId === n.clipId && i.accountKey === accountKey));
    items.push({
      date: kstDate(),
      title: n.title,
      program: String(n.clip.programTitle ?? "").trim(),
      channelLabel: String(n.channelLabel ?? n.accountId).trim() || n.accountId,
      videoId: n.videoId,
      url: `https://youtu.be/${n.videoId}`,
      durationSec: Number.isFinite(Number(n.clip.durationSec)) ? Number(n.clip.durationSec) : null,
      publishedAtMs: Date.now(),
      publishAt: n.publishAt ?? null,
      ...(n.clipId ? { clipId: n.clipId, accountKey } : {}),
    });
    await setAutomationSetting(REPORT_BUFFER_KEY, JSON.stringify(items.slice(-100)));
    console.log(`[report] 자동배포 적립 ${n.videoId} (${items.length}건 대기)`);
  } catch (e) {
    console.warn("[report] 자동배포 적립 실패:", e instanceof Error ? e.message : e);
  }
}

/**
 * **실패 1건 적립** (2026-08-26). 성공만 적립하던 리포트의 가장 큰 구멍을 막는다.
 *
 * 하루 20건이 도는 계정에서 3건이 조용히 실패하면, 예전 리포트는 "17건 게시 · 확인 필요 0"
 * 이라고 말했다 — 담당자는 20건이 다 나간 줄 안다. 실패는 **자동 재시도를 하지 않는**
 * 상태(F4-4)라 사람이 배포 화면에서 눌러야 풀리는데, 그 사실이 어디에도 도달하지 않았다.
 *
 * 같은 (클립·채널·계정)은 **한 줄만** 유지한다 — 재시도가 또 실패해도 줄이 늘지 않고
 * 최신 사유로 갱신된다. 성공이 뒤따르면 위 recordAutoPublishForReport 가 이 줄을 지운다.
 */
export async function recordAutoPublishFailureForReport(f: {
  clip: { programTitle?: unknown; durationSec?: unknown; distributions?: unknown };
  clipId: string;
  title: string;
  channel: string;
  accountId?: string;
  channelLabel?: string;
  error: string;
}): Promise<void> {
  try {
    if (!mailConfigured()) return;
    if (!(await notifyEmail())) return;
    // 자동 경로만 — 사람이 누른 배포의 실패는 그 화면에서 이미 보인다.
    if (!isAutoOrigin({ clip: f.clip, channel: f.channel as "youtube", accountId: f.accountId ?? "" })) return;
    const accountKey = `${f.channel}:${f.accountId ?? ""}`;
    const items = (await readBuffer())
      .filter((i) => !(i.failed && i.clipId === f.clipId && i.accountKey === accountKey));
    items.push({
      date: kstDate(),
      title: f.title,
      program: String(f.clip.programTitle ?? "").trim(),
      channelLabel: String(f.channelLabel ?? f.accountId ?? "").trim(),
      videoId: "",
      url: "",
      durationSec: Number.isFinite(Number(f.clip.durationSec)) ? Number(f.clip.durationSec) : null,
      publishedAtMs: Date.now(),
      publishAt: null,
      failed: true,
      error: String(f.error).slice(0, 300),
      clipId: f.clipId,
      accountKey,
    });
    await setAutomationSetting(REPORT_BUFFER_KEY, JSON.stringify(items.slice(-100)));
    console.log(`[report] 자동배포 실패 적립 ${f.clipId} (${f.channel})`);
  } catch (e) {
    console.warn("[report] 자동배포 실패 적립 실패:", e instanceof Error ? e.message : e);
  }
}

/** 한 (계획×채널)의 오늘 목표와 마감 — 순수 판정. 테스트가 이 함수를 직접 짚는다. */
export function ruleDayTarget(
  rule: Pick<AutomationRule, "slots" | "dailyQuota" | "activeEnd">,
  published: number,
  now: Date,
): { target: number; deadlinePassed: boolean } {
  const slots: RuleSlot[] = ruleSlots(rule);
  if (slots.length) {
    // 오늘 실제로 나가야 할 몫 = 슬롯 총합 − 오늘 포기한 몫(staleMissedSlots · 늦게 켠 계획 등).
    const target = Math.max(0, slots.reduce((n, s) => n + s.count, 0) - staleMissedSlots(slots, published, now));
    const lastMin = slots.reduce((m, s) => {
      const [h, mm] = s.time.split(":").map(Number);
      return Math.max(m, h * 60 + mm);
    }, 0);
    // 마지막 슬롯 +90분이 지나면 목표 미달(확정 실패 등)이어도 마감 — 그때까지 몫으로 보낸다.
    return { target, deadlinePassed: kstMinutes(now) > lastMin + 90 };
  }
  const target = allowedToday(rule as AutomationRule, now);
  const end = Number((rule as AutomationRule).activeEnd ?? 22);
  return { target, deadlinePassed: kstMinutes(now) > end * 60 };
}

/** 오늘 나갈 몫이 전부 나갔나(또는 전부 마감 지났나) — 하나라도 진행 중이면 false. */
async function todaysPublishingDone(now: Date): Promise<boolean> {
  // DB 행(AutomationRuleRow)은 판정 헬퍼들이 쓰는 필드를 전부 담고 있다 — 순방과 같은 캐스트.
  const rules = ((await listAutomationRules()) as unknown as AutomationRule[]).filter(
    (r) => r.enabled !== false && isPublishDay(r, now) && ruleChannels(r).length > 0,
  );
  for (const rule of rules) {
    for (const chan of ruleChannels(rule)) {
      const published = await publishedTodayKst(`${chan.platform}:${chan.accountId}`);
      const { target, deadlinePassed } = ruleDayTarget(rule, published, now);
      if (published < target && !deadlinePassed) return false;
    }
  }
  return true;
}

/** "다음 배포" 박스 — 내일부터 7일 안에서 첫 발행일과 그날의 예정 건수·첫 시각. */
async function nextPublishInfo(now: Date): Promise<{ label: string } | null> {
  const rules = ((await listAutomationRules()) as unknown as AutomationRule[]).filter(
    (r) => r.enabled !== false && ruleChannels(r).length > 0,
  );
  if (!rules.length) return null;
  for (let d = 1; d <= 7; d++) {
    const day = new Date(now.getTime() + d * 86_400_000);
    const due = rules.filter((r) => isPublishDay(r, day));
    if (!due.length) continue;
    const count = due.reduce((n, r) => n + perDayCount(r) * ruleChannels(r).length, 0);
    const firstSlot = due.flatMap((r) => ruleSlots(r).map((s) => s.time)).sort()[0];
    const time = firstSlot ?? `${String(due[0].activeStart ?? 9).padStart(2, "0")}:00`;
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(day).replace(/-/g, ". ");
    const w = KST_WD[new Date(day.toLocaleString("en-US", { timeZone: "Asia/Seoul" })).getDay()];
    return { label: `${p} (${w}) ${time} · ${count}건 예정` };
  }
  return null;
}

const FONT = `-apple-system,'Apple SD Gothic Neo','Pretendard','Malgun Gothic',Helvetica,Arial,sans-serif`;
const esc = (s: string) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 리포트 HTML — final-normal.html(사용자 확정 템플릿)을 데이터로 채운 것. */
export function buildAutoPublishReportHtml(
  items: AutoReportItem[], now: Date, next: { label: string } | null,
): string {
  const programs = [...new Set(items.map((i) => i.program).filter(Boolean))];
  // 생 채널 ID(UC…)는 사람이 읽는 자리에 안 올린다 — channelLabel 은 이름이 없으면
  // accountId 로 폴백하는데, 그 꼴이 제목줄에 그대로 노출됐다(2026-08-26 ENA 메일).
  // 워커가 이제 channelName 을 싣지만, 이미 버퍼에 쌓인 옛 항목도 여기서 걸러진다.
  const readable = (s: string) => !/^UC[A-Za-z0-9_-]{20,}$/.test(s);
  const channels = [...new Set(items.map((i) => i.channelLabel).filter(Boolean).filter(readable))];
  // 실패는 게시 수에서 빠지고 **'확인 필요'** 로 센다 — 예전엔 성공만 적립돼서 20건 중
  // 3건이 실패한 날에도 "확인 필요 0" 이 나갔다(2026-08-26). 실패는 자동 재시도가 없으므로
  // 이 숫자가 곧 사람이 할 일의 개수다.
  const failedItems = items.filter((i) => i.failed);
  const okItems = items.filter((i) => !i.failed);
  const scheduled = okItems.filter((i) => i.publishAt);
  const publishedCount = okItems.length - scheduled.length;
  const subtitle = `${programs.join(" · ") || "자동배포"} · YouTube${channels.length ? ` ${channels.join(" · ")}` : ""}`;
  const stamp = `${kstDate(now).replace(/-/g, ".")} ${kstHm(now)} KST`;
  // 실패가 있으면 프리헤더(받은함 미리보기)부터 그 사실을 말한다 — 메일을 열기 전에 보인다.
  const preheader = failedItems.length
    ? `배포 ${items.length}건 중 ${failedItems.length}건 확인 필요. 배포 화면에서 재시도해 주세요.`
    : `배포 ${items.length}건 전부 게시 완료. 확인 필요 항목 없음.`;

  const itemHtml = (i: AutoReportItem, first: boolean) => {
    const sep = first ? "" : `<tr><td class="px" style="padding:30px 40px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#E9E8E6" style="height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr></table></td></tr>`;
    const pad = `padding:${first ? "34px" : "30px"} 40px 0 40px;`;
    const titleDiv = `<div style="font-family:${FONT};font-size:16px;font-weight:600;line-height:27px;mso-line-height-rule:exactly;letter-spacing:-0.01em;color:#1F2124;word-break:keep-all;">${esc(i.title)}</div>`;

    // 실패 항목 — 열 영상이 없으니 '영상 열기' 대신 **사유와 다음 행동**을 싣는다.
    // 점 색도 청록(정상)이 아니라 주황이어야 훑어볼 때 눈에 걸린다.
    if (i.failed) {
      const metaBits = [readable(i.channelLabel) ? i.channelLabel : "", fmtDur(i.durationSec),
        `${kstHm(new Date(i.publishedAtMs))} 실패`].filter(Boolean).join(" · ");
      return `${sep}
  <tr><td class="px" style="${pad}">
    ${titleDiv}
    <div style="padding-top:8px;font-family:${FONT};font-size:13px;font-weight:400;line-height:20px;color:#5C5E63;">${esc(metaBits)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;" bgcolor="#FBF2EC"><tr><td style="background:#FBF2EC;border-radius:6px;padding:16px 18px;">
      <div style="font-family:${FONT};font-size:13px;font-weight:600;line-height:20px;color:#B4522A;"><span style="display:inline-block;width:5px;height:5px;background:#E2703A;vertical-align:2px;margin-right:8px;font-size:0;line-height:0;">&nbsp;</span>확인 필요</div>
      <div style="padding-top:8px;font-family:${FONT};font-size:13px;font-weight:400;line-height:21px;color:#5C5E63;word-break:keep-all;">${esc(i.error ?? "게시에 실패했습니다")}</div>
      <div style="padding-top:8px;font-family:${FONT};font-size:13px;font-weight:400;line-height:21px;color:#5C5E63;word-break:keep-all;">자동으로 다시 보내지 않습니다 — 배포 화면에서 재시도를 눌러 주세요.</div>
    </td></tr></table>
  </td></tr>`;
    }

    const at = i.publishAt ? new Date(i.publishAt) : new Date(i.publishedAtMs);
    const metaBits = [readable(i.channelLabel) ? i.channelLabel : "", fmtDur(i.durationSec),
      `${kstHm(at)} ${i.publishAt ? "공개 예정" : "게시"}`]
      .filter(Boolean).join(" · ");
    const dot = i.publishAt ? "예약" : "공개";
    return `${sep}
  <tr><td class="px" style="${pad}">
    ${titleDiv}
    <div style="padding-top:8px;font-family:${FONT};font-size:13px;font-weight:400;line-height:20px;color:#5C5E63;">${esc(metaBits)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px;"><tr>
      <td align="left" valign="middle" style="padding:6px 0;"><span style="font-family:${FONT};font-size:13px;font-weight:600;line-height:32px;color:#1F2124;"><span style="display:inline-block;width:5px;height:5px;background:#47EBEB;vertical-align:2px;margin-right:8px;font-size:0;line-height:0;">&nbsp;</span>${dot}</span></td>
      <td align="right" valign="middle" style="padding:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right"><tr><td bgcolor="#1F2124" align="center" style="background:#1F2124;border-radius:6px;"><a class="btn" href="${esc(i.url)}" style="display:block;padding:13px 22px;font-family:${FONT};font-size:14px;font-weight:600;line-height:18px;color:#FDFCFC;text-decoration:none;">영상 열기</a></td></tr></table></td>
    </tr></table>
  </td></tr>`;
  };

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<style>
  @media only screen and (max-width:620px) {
    .px { padding-left:22px !important; padding-right:22px !important; }
    .band { padding:26px 22px 32px 22px !important; }
    .slot { padding-top:30px !important; }
    .outer { padding:16px 10px !important; }
    .btn { padding-left:38px !important; padding-right:38px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F0EEEB;-webkit-text-size-adjust:100%;">
<span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0EEEB;">
<tr><td class="outer" align="center" style="padding:40px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FDFCFC;border-radius:8px;">

  <tr><td class="band" bgcolor="#0E0F14" style="background:#0E0F14;border-radius:8px 8px 0 0;padding:34px 40px 44px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;letter-spacing:-0.01em;color:#FDFCFC;">STEP AI</td>
    </tr></table>
    <div class="slot" style="padding-top:44px;font-family:SFMono-Regular,Consolas,Menlo,'Courier New',monospace;font-size:12px;line-height:18px;letter-spacing:0.08em;color:#5C5E63;">${esc(stamp)}</div>
    <div style="padding-top:14px;font-family:${FONT};font-size:34px;font-weight:600;line-height:44px;mso-line-height-rule:exactly;letter-spacing:-0.02em;color:#FDFCFC;word-break:keep-all;">자동배포 리포트</div>
    <div style="padding-top:12px;font-family:${FONT};font-size:16px;font-weight:400;line-height:27px;mso-line-height-rule:exactly;color:#5C5E63;word-break:keep-all;">${esc(subtitle)}</div>
  </td></tr>
  <tr><td class="px" style="padding:36px 40px 32px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="33%" align="left" valign="top" style="width:33%;">
        <div style="font-family:${FONT};font-size:13px;font-weight:600;line-height:18px;color:#5C5E63;">배포</div>
        <div style="padding-top:10px;font-family:${FONT};font-size:44px;font-weight:600;line-height:46px;mso-line-height-rule:exactly;letter-spacing:-0.03em;color:#1F2124;">${items.length}</div>
      </td>
      <td width="33%" align="left" valign="top" style="width:33%;">
        <div style="font-family:${FONT};font-size:13px;font-weight:600;line-height:18px;color:#5C5E63;">게시</div>
        <div style="padding-top:10px;font-family:${FONT};font-size:44px;font-weight:600;line-height:46px;mso-line-height-rule:exactly;letter-spacing:-0.03em;color:#1F2124;">${publishedCount}</div>
      </td>
      <td width="34%" align="left" valign="top" style="width:34%;">
        <div style="font-family:${FONT};font-size:13px;font-weight:600;line-height:18px;color:#5C5E63;">확인 필요</div>
        <div style="padding-top:10px;font-family:${FONT};font-size:44px;font-weight:600;line-height:46px;mso-line-height-rule:exactly;letter-spacing:-0.03em;color:${failedItems.length ? "#B4522A" : "#5C5E63"};">${failedItems.length}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td class="px" style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#E9E8E6" style="height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr></table></td></tr>
${[...failedItems, ...okItems].map((i, k) => itemHtml(i, k === 0)).join("\n")}
<tr><td class="px" style="padding:30px 40px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="#E9E8E6" style="height:1px;line-height:1px;font-size:0;">&nbsp;</td></tr></table></td></tr>
${next ? `  <tr><td class="px" style="padding:32px 40px 0 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F5F3F1" style="background:#F5F3F1;border-radius:6px;"><tr><td style="padding:22px 24px;">
      <div style="font-family:${FONT};font-size:13px;font-weight:600;line-height:18px;color:#5C5E63;">다음 배포</div>
      <div style="padding-top:8px;font-family:${FONT};font-size:16px;font-weight:600;line-height:26px;mso-line-height-rule:exactly;color:#1F2124;">${esc(next.label)}</div>
    </td></tr></table>
  </td></tr>` : ""}
  <tr><td style="padding:0 40px 40px 40px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * 순방 끝에서 부른다 — 오늘 몫이 다 나갔으면(또는 지난 날 항목이 남았으면) 리포트 발송.
 * **절대 던지지 않는다.** 순방은 리포트보다 중요하다.
 */
export async function maybeFlushAutoPublishReport(now = new Date()): Promise<void> {
  try {
    if (!mailConfigured()) return;
    const items = await readBuffer();
    if (!items.length) return;
    const today = kstDate(now);
    const hasStale = items.some((i) => i.date !== today);
    // 오늘 항목뿐이면 "오늘 몫 완료" 판정을 기다린다. 지난 날 항목이 있으면 그건 이미
    // 마감을 넘긴 묶음 — 지금 보낸다(더 기다릴 이유가 없다).
    if (!hasStale && !(await todaysPublishingDone(now))) return;

    const to = await notifyEmail();
    if (!to) {
      // 담당자 이메일이 중간에 지워졌다 — 묶음을 비워 좀비 버퍼를 막는다(다음 설정부터 새로).
      await setAutomationSetting(REPORT_BUFFER_KEY, "");
      return;
    }
    const next = await nextPublishInfo(now).catch(() => null);
    const programs = [...new Set(items.map((i) => i.program).filter(Boolean))];
    const programLabel = programs.length > 1 ? `${programs[0]} 외 ${programs.length - 1}` : (programs[0] ?? "자동배포");
    await sendMail({
      to,
      // 제목 브랜드는 STEP AI (사용자 2026-08-26 — 본문 푸터의 "STEP D 자동배포 시스템"은 템플릿 원문 유지).
      subject: `[STEP AI] ${programLabel} 자동배포 리포트 · ${kstMdw(now)} ${kstHm(now)} · ${items.length}건`,
      html: buildAutoPublishReportHtml(items, now, next),
    });
    await setAutomationSetting(REPORT_BUFFER_KEY, "");
    console.log(`[report] 자동배포 리포트 발송 → ${to} (${items.length}건)`);
  } catch (e) {
    console.warn("[report] 자동배포 리포트 발송 실패:", e instanceof Error ? e.message : e);
  }
}
