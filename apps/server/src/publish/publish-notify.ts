/**
 * 자동배포 리포트 메일 — **영상마다 한 통이 아니라, 하루 몫이 다 나가면 묶어서 한 통**
 * (사용자 2026-08-26 · 템플릿: KT ENA 자동배포 리포트 final-normal.html).
 *
 * 흐름:
 *  1. 워커가 실업로드에 성공할 때마다 `recordAutoPublishForReport` 로 **버퍼에 적립**만 한다
 *     (automation_setting KV · 테넌트 스코프). 메일은 여기서 안 보낸다.
 *  2. 순방(automation-cycle · 15분)이 끝날 때 `maybeFlushAutoPublishReport` 가
 *     **자동배포 계획마다** "그 계획의 마감이 지났나"를 판정하고, 지난 계획의 리포트 한 통을
 *     보낸 뒤 그 계획 적립분만 버퍼에서 뺀다(2026-08-28 계획당 한 통 · 2026-09-02 마감 후 한 통).
 *     지난 날짜 항목이 남아 있으면(어제 마감 후 늦게 올라간 예약분 등) 다음 순방에서 즉시
 *     보낸다 — 묶음이 하루를 넘겨 썩지 않는다.
 *
 * 원칙 (구 영상별 알림에서 계승):
 *  - **자동 경로만**(origin automation·factory). 사람이 누른 배포는 그 사람이 이미 안다.
 *  - **설정 없으면 아무것도 안 한다.** 담당자 이메일(NOTIFY_EMAIL_KEY) 없으면 적립도 안 한다.
 *  - **베스트 에포트.** 게시는 이미 끝난 사실 — 어떤 실패도 던지지 않는다.
 *
 * ⚠️ **갈라질 수 있을 때만 기다린다**(2026-09-02 · ruleReportDue 주석이 정본).
 * 몫이 다 나가자마자 보내면 그 뒤에 확정되는 사실(재시도 성공 · 슬롯 직전 예약분)이 갈 곳이
 * 없어 두 번째 통이 된다. 그렇다고 늘 마감까지 붙잡으면 다 끝난 날에도 90분을 기다린다.
 * 그래서 **실패 항목이 남아 있거나 목표를 못 채운 동안만** 기다리고, 다 채웠으면 바로 보낸다.
 *
 * ⚠️ 남는 갈라짐: **마감 뒤에** 확정되는 건(늦은 재시도 성공 등)은 여전히 다음 통으로 간다.
 * 그건 이미 나간 리포트를 고칠 수 없어서지 정책 때문이 아니다.
 *
 * 콘텐츠 공장(factory) 배포는 클립에 automationRuleId 가 없어 계획 묶음과 합쳐지지 않는다.
 * 합치면 계획 수치(오늘 N건 예정 중 M건)가 공장 건까지 세므로 **일부러 따로 둔다.** 대신
 * 같은 마감을 기다리게 하고(orphanReportDue) 제목에 출처를 붙여(sourceTag) 구분한다 —
 * 예전엔 즉시 발송이라 이른 시각에 한 통이 더 오는 것으로 보였다(2026-09-02).
 */
import {
  getAutomationSetting, setAutomationSetting, listAutomationRules,
  publishedBySlotKst, publishedTodayKst,
} from "../db-pg.ts";
import {
  NOTIFY_EMAIL_KEY, allowedToday, claimableSlots, isPublishDay, kstMinutes, parseNotifyEmails,
  perDayCount, ruleChannels, ruleSlots, staleMissedSlots, type AutomationRule, type RuleSlot,
} from "../pipeline/automation.ts";
import { mailConfigured, sendMail } from "../mailer.ts";

const AUTO_ORIGINS = new Set(["automation", "factory"]);
/** 적립 버퍼 KV 키 — 값은 AutoReportItem[] JSON. 테넌트 스코프(automation_setting PK). */
export const REPORT_BUFFER_KEY = "automation.report.pending";

export interface AutoPublishNotice {
  /** 배포 기록을 가진 클립 — origin 판정과 프로그램명·길이 표기에 쓴다. */
  clip: { programTitle?: unknown; durationSec?: unknown; distributions?: unknown; automationRuleId?: unknown };
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
  /**
   * 어느 자동배포 계획의 건인가 — **메일을 계획마다 따로 보내는 축**(2026-08-28 사용자 지시).
   *
   * 클립을 **채택한** 계획 id(clip.automationRuleId)다. 게시한 계획과 다를 수 있다(지워진
   * 계획의 고아 클립을 다른 계획이 이어받는 경우) — 그때는 이 id 로 계획이 안 찾아지므로
   * 발송 시점에 "지난 계획" 묶음으로 빠지고, 기다리지 않고 바로 나간다. 값이 없는 옛 항목도
   * 같은 길로 간다 — 버퍼에 남아 썩는 것보다 낫다.
   */
  ruleId?: string;
}

/** 클립이 속한 계획 id — 없으면 키 자체를 안 넣는다(옛 항목과 같은 꼴로 남는다). */
const ruleIdOf = (clip: { automationRuleId?: unknown }): { ruleId?: string } => {
  const id = String(clip?.automationRuleId ?? "").trim();
  return id ? { ruleId: id } : {};
};

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

/**
 * 리포트 수신자 목록 (2026-09-02 여러 명). 빈 배열 = 담당자 미설정 = 아무것도 하지 않는다.
 * 옛 단일 문자열 저장값도 parseNotifyEmails 가 그대로 읽는다(하위호환).
 */
async function notifyEmails(): Promise<string[]> {
  return parseNotifyEmails(await getAutomationSetting(NOTIFY_EMAIL_KEY));
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
    if (!(await notifyEmails()).length) return;   // 담당자 이메일 없으면 적립도 안 한다(버퍼 무한성장 방지)
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
      ...ruleIdOf(n.clip),
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
  clip: { programTitle?: unknown; durationSec?: unknown; distributions?: unknown; automationRuleId?: unknown };
  clipId: string;
  title: string;
  channel: string;
  accountId?: string;
  channelLabel?: string;
  error: string;
}): Promise<void> {
  try {
    if (!mailConfigured()) return;
    if (!(await notifyEmails()).length) return;
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
      ...ruleIdOf(f.clip),
    });
    await setAutomationSetting(REPORT_BUFFER_KEY, JSON.stringify(items.slice(-100)));
    console.log(`[report] 자동배포 실패 적립 ${f.clipId} (${f.channel})`);
  } catch (e) {
    console.warn("[report] 자동배포 실패 적립 실패:", e instanceof Error ? e.message : e);
  }
}

/**
 * 한 (계획×채널)의 오늘 목표와 두 시각 — 순수 판정. 테스트가 이 함수를 직접 짚는다.
 *
 * `deadlinePassed` 는 **안전장치**다(마지막 슬롯 +90분 · 활동창 끝). 목표에 못 닿아도 언젠가는
 * 리포트가 나가게 한다 — 확정 실패 1건이 리포트를 영원히 잠그면 안 되기 때문이다.
 * `lastSlotPassed` 는 **소재 고갈 즉시 발송**의 전제다: 오늘 마지막 슬롯이 이미 지났고 더 뽑을
 * 후보도 없으면 90분을 더 기다릴 이유가 없다(사용자 2026-08-27 "왜 4시 30분이지").
 * 슬롯이 여럿이면 마지막 슬롯 전에는 절대 안 보낸다 — 뒤 슬롯 몫이 리포트에서 빠지면 안 된다.
 */
export function ruleDayTarget(
  rule: Pick<AutomationRule, "slots" | "dailyQuota" | "activeEnd">,
  published: number,
  now: Date,
): { target: number; deadlinePassed: boolean; lastSlotPassed: boolean } {
  const slots: RuleSlot[] = ruleSlots(rule);
  if (slots.length) {
    // 오늘 실제로 나가야 할 몫 = 슬롯 총합 − 오늘 포기한 몫(staleMissedSlots · 늦게 켠 계획 등).
    const target = Math.max(0, slots.reduce((n, s) => n + s.count, 0) - staleMissedSlots(slots, published, now));
    const lastMin = slots.reduce((m, s) => {
      const [h, mm] = s.time.split(":").map(Number);
      return Math.max(m, h * 60 + mm);
    }, 0);
    const cur = kstMinutes(now);
    return { target, deadlinePassed: cur > lastMin + 90, lastSlotPassed: cur >= lastMin };
  }
  const target = allowedToday(rule as AutomationRule, now);
  const end = Number((rule as AutomationRule).activeEnd ?? 24);
  // 할당량 방식은 활동창 내내 나갈 수 있어 '마지막 슬롯' 이 없다 — 마감(활동창 끝)만 본다.
  //
  // ⚠️ 24시간 계획(활동창 0~24 · 2026-09-02 기본)은 끝이 자정이라 `end * 60 = 1440` 인데
  //    kstMinutes 는 최대 1439 다 — 그대로 두면 **마감이 영영 안 와서 리포트가 하루 늦는다**
  //    (다음 날 hasStale 경로로만 나간다). 그날 마지막 순방에 나가도록 23:59 로 접는다.
  const endMin = Math.min(end * 60, 23 * 60 + 59);
  const deadlinePassed = kstMinutes(now) >= endMin;
  return { target, deadlinePassed, lastSlotPassed: deadlinePassed };
}

/**
 * **한 계획의** 오늘 목표와 실제 게시 수 — 리포트의 "영상이 모자랍니다" 섹션 근거.
 *
 * 메일이 계획마다 따로 나가므로(2026-08-28) 합산도 그 계획 안에서만 한다. 예전엔 워크스페이스
 * 전체를 더해서, A 계획이 다 나간 날에도 B 계획의 미달분이 A 메일에 "모자랍니다" 로 실렸다.
 * 계획 단위로 세므로(publishedTodayKst 의 ruleId) 한 채널을 두 계획이 함께 써도 안 섞인다.
 * 목표는 순방과 **같은 함수**(ruleDayTarget)로 낸다 — 메일이 다른 수를 말하면 안 된다.
 */
async function rulePlanTotals(rule: AutomationRule, now: Date): Promise<{ target: number; published: number }> {
  const slots = ruleSlots(rule);
  let target = 0;
  let published = 0;
  for (const chan of ruleChannels(rule)) {
    const key = `${chan.platform}:${chan.accountId}`;
    const n = await publishedTodayKst(key, rule.id);
    published += n;
    if (slots.length) {
      // ⚠️ 순방과 **같은 어휘**로 센다 (2026-09-02 슬롯 단위 전환). 창이 닫힌 슬롯 몫은
      // 소멸했으므로 목표에서도 빠져야 한다 — 안 빼면 "20건 예정 중 16건" 처럼 **이미
      // 포기한 몫을 못 채운 것처럼** 말하고, 메일이 매일 거짓 부족을 띄운다.
      // 목표 = 이미 나간 수 + 아직 채울 수 있는 수.
      const bySlot = await publishedBySlotKst(key, rule.id);
      const open = claimableSlots(slots, bySlot, now).reduce((m, c) => m + c.remaining, 0);
      target += n + open;
    } else {
      target += ruleDayTarget(rule, n, now).target;
    }
  }
  return { target, published };
}

/**
 * **이 계획의** 리포트를 지금 보낼 때인가 (정책 2026-09-02 · 같은 날 두 번 손봄).
 *
 * ## 막으려는 것 — 메일이 두 통으로 갈라지는 일
 * 원래는 "오늘 몫이 다 나갔으면" 즉시 보냈다. 그래서 **리포트가 나간 뒤에 확정되는 사실**이
 * 갈 곳을 잃고 두 번째 통이 됐다: 실패했던 건의 **재시도 성공**, 슬롯 직전에 올라가는
 * **예약·지연 업로드**. (사용자 "가끔 메일이 2개로 나눠져서 온다")
 *
 * ## 그렇다고 늘 마감까지 기다리면 안 된다
 * 첫 수정에서 마감(마지막 슬롯 +90분)만 보게 했더니, **다 나간 날에도 90분을 기다렸다**
 * (사용자 같은 날: "이미 다 나갔는데 왜 +90분"). 마감은 원래 *목표를 못 채운 날에도 언젠가는
 * 보낸다* 는 **안전장치**이지, 다 끝난 날까지 붙잡으라는 뜻이 아니었다.
 *
 * ## 그래서 지금 규칙 — 갈라질 수 있을 때만 기다린다
 *   1. 마감이 지났다                          → 보낸다 (안전장치 · 목표 미달이어도)
 *   2. 버퍼에 **실패 항목**이 있다            → 기다린다 (재시도가 성공으로 뒤집으면 그 사실이
 *                                              같은 통에 담겨야 한다 — 갈라짐의 실제 원인)
 *   3. 오늘 목표를 **다 채웠다**              → 보낸다 (더 담길 게 없다)
 *   4. 그 외(아직 덜 나갔다)                  → 기다린다 (남은 몫이 같은 통에 담겨야 한다)
 *
 * 3번이 있어서 "다 나가면 바로" 가 돌아오고, 2번이 있어서 갈라짐은 여전히 막힌다.
 * 둘은 같은 조건이 아니었는데 첫 수정에서 뭉뚱그렸던 것이다.
 *
 * ## 마감
 * 슬롯 계획 = 마지막 슬롯 +90분 · 할당량 계획 = 활동창 끝(activeEnd). 순방과 **같은
 * 함수**(ruleDayTarget)에서 낸다.
 *
 * 발행일이 아니거나 꺼진 계획·채널 없는 계획은 기다릴 이유가 없다 → 바로 보낸다.
 */
async function ruleReportDue(rule: AutomationRule, now: Date, items: AutoReportItem[]): Promise<boolean> {
  if (rule.enabled === false || !isPublishDay(rule, now) || ruleChannels(rule).length === 0) return true;
  if (ruleDayTarget(rule, 0, now).deadlinePassed) return true;
  // 뒤집힐 수 있는 항목이 있으면 마감까지 기다린다 — 재시도 성공이 두 번째 통이 되는 걸 막는다.
  if (items.some((i) => i.failed)) return false;
  // 오늘 몫을 다 채웠나. target 0(늦게 켠 계획 등)은 "달성" 으로 치지 않는다 — 그 경우
  // 게시 수도 0이라 `0 >= 0` 으로 통과해 버린다.
  const totals = await rulePlanTotals(rule, now).catch(() => null);
  return totals != null && totals.target > 0 && totals.published >= totals.target;
}


/**
 * **계획이 없는 묶음**의 발송 시각 — 살아 있는 계획들의 마감이 **전부** 지났을 때.
 *
 * 이런 묶음이 생기는 경로 둘: ① 콘텐츠 공장(factory)이 올린 건 — origin 은 자동이라 리포트에
 * 적립되는데 클립에 automationRuleId 가 없다(factory.ts 에 그 필드가 아예 없다) ② 지워진
 * 계획의 고아 클립.
 *
 * 예전엔 계획을 못 찾으면 **즉시** 보냈다. 그래서 공장과 계획이 같은 날 배포한 날에는
 * 이른 시각에 한 통, 마감에 또 한 통 — 사용자가 본 "가끔 2개로 나눠져서 온다" 의 나머지
 * 절반이다(2026-09-02). 이제 같은 마감을 기다리므로 **같은 시각에** 나간다.
 *
 * ⚠️ 합치지는 않는다. 공장 배포는 계획의 몫이 아니라서 한 통에 담으면 "오늘 20건 예정 중
 *    16건" 같은 계획 수치가 공장 건까지 세게 된다. 대신 제목에 출처를 붙여 구분한다(sourceTag).
 * ⚠️ 살아 있는 계획이 하나도 없으면 기다릴 근거가 없다 → 즉시 발송(종전과 같다). 안 그러면
 *    계획을 다 지운 워크스페이스에서 공장 리포트가 영영 안 나간다.
 */
function orphanReportDue(rules: AutomationRule[], now: Date): boolean {
  const live = rules.filter((r) => r.enabled !== false && isPublishDay(r, now) && ruleChannels(r).length > 0);
  if (live.length === 0) return true;
  return live.every((r) => ruleDayTarget(r, 0, now).deadlinePassed);
}

/**
 * 제목에 붙는 출처 꼬리표 — **두 통이 왔을 때 무엇이 다른지 한눈에 보이게** 한다.
 * 계획 리포트는 꼬리표가 없다(종전 제목 그대로 · 대부분의 메일이 이쪽이다).
 */
function sourceTag(ruleId: string, rule: AutomationRule | undefined): string {
  if (rule) return "";
  return ruleId ? " (지워진 계획)" : " (계획 외 배포)";
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
    // ⚠️ **그 시각에 나갈 개수만 센다** (사용자 2026-09-02: "딱 다음에 나갈 배포 개수만").
    // 예전엔 하루 전체 합을 적어서 `06:30 · 14건` 처럼 **시각과 개수가 안 맞았다** —
    // 06:30 에는 2건이 나가는데 14건이라고 예고하면 담당자가 아침에 그만큼을 기다린다.
    const firstSlot = due.flatMap((r) => ruleSlots(r).map((s) => s.time)).sort()[0];
    const count = firstSlot
      // 슬롯 계획: 그 시각 슬롯의 개수만 (여러 계획이 같은 시각을 쓰면 합산 · 채널 수만큼 곱)
      ? due.reduce((n, r) => n + ruleSlots(r)
          .filter((s) => s.time === firstSlot)
          .reduce((m, s) => m + s.count, 0) * ruleChannels(r).length, 0)
      // 할당량 계획은 '시각' 이 없다 — 활동창 안에서 하루치가 흩어지므로 하루 합이 맞다.
      : due.reduce((n, r) => n + perDayCount(r) * ruleChannels(r).length, 0);
    const time = firstSlot ?? `${String(due[0].activeStart ?? 0).padStart(2, "0")}:00`;
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
/**
 * 오늘 목표에 못 미친 사실 + 그 조치 — **소재(영상)가 모자란 날 리포트가 말해 주는 것**
 * (사용자 2026-08-27 "16개 나갔을 때는 메일로 더 영상을 넣어 달라고 알려주면서 결제 유도").
 *
 * 목표는 계획 설정(슬롯 합)이고 실적은 실제 게시분이다. 차이는 대개 "채택할 추천이 없다" —
 * 회차를 더 올려야 풀린다. **문구만 싣는다** — 잔액·버튼은 사용자 요청으로 뺐다
 * (2026-08-27 "크레딧 보여줄 필요 없음" · "버튼은 만들지 마").
 */
export interface ReportShortfall {
  /** 오늘 계획 목표(슬롯 합) · 실제 나간 수. target > published 일 때만 섹션이 그려진다. */
  target: number;
  published: number;
}

export function buildAutoPublishReportHtml(
  items: AutoReportItem[], now: Date, next: { label: string } | null,
  shortfall: ReportShortfall | null = null,
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
  // ⚠️ 이 배너는 **제목 바로 아래**(통계 위)에 그린다 — 아래에 두면 사람이 안 본다
  //    (사용자 2026-08-28). 리포트를 여는 사람이 알아야 할 첫 사실은 "몇 건 나갔나" 가
  //    아니라 "왜 계획보다 적게 나갔나" 이고, 그 조치(회차 영상 올리기)는 오늘 해야 한다.
  // 소재 부족 — 오늘 계획한 수를 못 채운 날. 실패(게시 실패)와 다른 축이다: 이건 **만들
  // 재료가 없어서** 안 나간 것이라 조치도 다르다(회차 업로드 · 그에 필요한 크레딧).
  const short = shortfall && shortfall.target > shortfall.published
    ? { ...shortfall, missing: shortfall.target - shortfall.published } : null;

  // 프리헤더(받은함 미리보기) — 열기 전에 오늘의 요점부터. 우선순위: 실패 > 소재 부족 > 정상.
  const preheader = failedItems.length
    ? `배포 ${items.length}건 중 ${failedItems.length}건 확인 필요. 배포 화면에서 재시도해 주세요.`
    : short
      ? `오늘 ${short.published}건 게시 · 영상이 모자라 ${short.missing}건을 못 채웠습니다.`
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
${short ? `  <tr><td class="px" style="padding:28px 40px 0 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0E0F14" style="background:#0E0F14;border-radius:6px;"><tr><td style="padding:24px 26px;">
      <div style="font-family:${FONT};font-size:13px;font-weight:600;line-height:18px;color:#47EBEB;">영상이 모자랍니다</div>
      <div style="padding-top:10px;font-family:${FONT};font-size:18px;font-weight:600;line-height:28px;mso-line-height-rule:exactly;color:#FDFCFC;word-break:keep-all;">오늘 ${short.target}건 예정 중 ${short.published}건 게시 · ${short.missing}건은 만들 영상이 없었습니다</div>
      <div style="padding-top:10px;font-family:${FONT};font-size:13px;font-weight:400;line-height:21px;color:#9A9CA1;word-break:keep-all;">회차 영상을 올려 주시면 AI가 분석해 다음 배포 시간에 자동으로 채웁니다. 크레딧이 넉넉해야 분석이 끊기지 않습니다.</div>
    </td></tr></table>
  </td></tr>` : ""}
  <tr><td class="px" style="padding:${short ? "20px" : "36px"} 40px 32px 40px;">
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
 * 순방 끝에서 부른다 — **계획의 마감이 지났으면**(또는 지난 날 항목이 남았으면) 리포트 발송.
 * **절대 던지지 않는다.** 순방은 리포트보다 중요하다.
 *
 * 발송 시점 판정은 ruleReportDue 한 곳이다(2026-09-02 · 이유는 그 함수 주석에).
 * 예전의 `opts.exhausted`(소재 고갈 조기 발송)는 제거했다 — 목표 달성 판정이 그 자리를
 * 대신하고, 고갈된 날은 마감이 받아 준다.
 */
export async function maybeFlushAutoPublishReport(now = new Date()): Promise<void> {
  try {
    if (!mailConfigured()) return;
    const items = await readBuffer();
    if (!items.length) return;

    const recipients = await notifyEmails();
    if (!recipients.length) {
      // 담당자 이메일이 중간에 지워졌다 — 묶음을 비워 좀비 버퍼를 막는다(다음 설정부터 새로).
      await setAutomationSetting(REPORT_BUFFER_KEY, "");
      return;
    }
    // nodemailer 는 쉼표 구분 문자열을 그대로 받는다(invoice-email.ts 와 같은 방식).
    const to = recipients.join(", ");

    // ── 계획마다 한 통 (2026-08-28 사용자 지시 "메일도 자동배포계획당으로 나가야 해") ──
    //
    // 예전엔 워크스페이스 전체를 한 통에 담았다. 계획이 둘이면 프로그램도 채널도 섞여
    // "A 외 1" 이라고만 적히고, **워크스페이스의 모든 계획이 끝나야** 발송돼서 늦게까지
    // 도는 계획 하나가 이미 끝난 계획의 리포트를 붙잡았다. 이제 계획별로 판정하고 보낸다 —
    // 끝난 계획은 바로 나가고, 각 통의 목표·미달 수치도 그 계획 것만 말한다.
    const rules = (await listAutomationRules()) as unknown as AutomationRule[];
    const byRule = new Map<string, AutoReportItem[]>();
    for (const item of items) {
      const key = item.ruleId ?? "";
      const bucket = byRule.get(key);
      if (bucket) bucket.push(item); else byRule.set(key, [item]);
    }

    const today = kstDate(now);
    const next = await nextPublishInfo(now).catch(() => null);
    const kept: AutoReportItem[] = [];

    // 계획 없는 묶음이 기다릴 시각 — 살아 있는 계획들의 **마지막 마감**. 아래 참고.
    const orphanDue = orphanReportDue(rules, now);

    for (const [ruleId, group] of byRule) {
      const rule = rules.find((r) => r.id === ruleId);
      // 지난 날 항목이 섞였으면 이미 마감을 넘긴 묶음이다 — 더 기다릴 이유가 없다.
      const hasStale = group.some((i) => i.date !== today);
      // 계획이 있으면 그 계획의 마감, 없으면 워크스페이스 마지막 마감까지 기다린다.
      const due = rule ? await ruleReportDue(rule, now, group) : orphanDue;
      if (!hasStale && !due) {
        kept.push(...group);          // 아직 마감 전이다 — 버퍼에 그대로 둔다
        continue;
      }

      // 소재 부족 안내 — 이 계획이 오늘 목표에 못 미쳤을 때만 그려진다(그 외엔 null 이라
      // 섹션 자체가 없다). 계획을 못 찾으면 목표를 알 수 없으므로 섹션 없이 보낸다.
      const totals = rule ? await rulePlanTotals(rule, now).catch(() => null) : null;
      const shortfall: ReportShortfall | null = totals && totals.target > totals.published
        ? { target: totals.target, published: totals.published }
        : null;
      const programs = [...new Set(group.map((i) => i.program).filter(Boolean))];
      const programLabel = programs.length > 1 ? `${programs[0]} 외 ${programs.length - 1}` : (programs[0] ?? "자동배포");
      try {
        await sendMail({
          to,
          // 제목 브랜드는 STEP AI (사용자 2026-08-26 — 본문 푸터의 "STEP D 자동배포 시스템"은 템플릿 원문 유지).
          subject: `[STEP AI] ${programLabel} 자동배포 리포트${sourceTag(ruleId, rule)} · ${kstMdw(now)} ${kstHm(now)} · ${group.length}건`,
          html: buildAutoPublishReportHtml(group, now, next, shortfall),
        });
      } catch (e) {
        // 한 통이 실패해도 나머지는 보낸다. **실패한 묶음만** 버퍼에 남긴다 — 통째로
        // 던지면 이미 보낸 묶음까지 남아 다음 순방에 두 번 나간다.
        console.warn(`[report] 계획 ${ruleId || "미상"} 리포트 발송 실패:`, e instanceof Error ? e.message : e);
        kept.push(...group);
        continue;
      }
      console.log(`[report] 자동배포 리포트 발송 → ${to} (계획 ${ruleId || "미상"} · ${group.length}건)`);
    }

    // 보낸 묶음만 버퍼에서 뺀다 — 아직 진행 중인 계획의 적립분은 다음 순방까지 살아 있어야 한다.
    await setAutomationSetting(REPORT_BUFFER_KEY, kept.length ? JSON.stringify(kept) : "");
  } catch (e) {
    console.warn("[report] 자동배포 리포트 발송 실패:", e instanceof Error ? e.message : e);
  }
}
