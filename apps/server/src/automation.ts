/**
 * 자동 배포 규칙 엔진 (FLOWS F6). 순수 모듈.
 *
 * **규칙 하나 = 프로그램 ↔ 채널 연결 하나.** 규칙만 만들어 두면 이후는 사람 손 없이 돈다.
 *
 * 이 파일이 지키는 불변식 둘 (FLOWS.md:142):
 *  1. **자동 배포는 게이트를 건너뛰지 않는다.** 보류된 건은 사람이 확정해야 다음 순방에
 *     다시 잡힌다 — 시간이 지났다고 저절로 풀리지 않는다.
 *  2. **규칙이 없으면 파이프라인은 아무것도 하지 않는다.** "전체 자동 실행" 같은 기본
 *     동작이 없다. 이건 편의 기능이 아니라 안전장치다 — 기본 동작이 있으면 규칙을
 *     하나도 안 만든 상태에서 뭔가가 나간다.
 */

export const RULE_MEDIA_KINDS = ["short", "clip", "both"] as const;
export type RuleMediaKind = (typeof RULE_MEDIA_KINDS)[number];

/** 채택 기준 — 점수 하한 또는 상위 N건. */
export const RULE_CRITERIA = ["score80", "score85", "top3"] as const;
export type RuleCriterion = (typeof RULE_CRITERIA)[number];

/**
 * 게이트 정책 (F6 규칙 항목).
 * - `approve_first`: 게시 전 사람 승인. 게이트를 통과해도 사람 손을 한 번 거친다.
 * - `hold_on_issue`: 권리 이슈가 있으면 보류. 통과면 그대로 나간다.
 *
 * ⚠️ 어느 쪽도 "게이트 무시"가 아니다. 둘 다 게이트 위에 얹히는 추가 조건이다.
 */
export const GATE_POLICIES = ["approve_first", "hold_on_issue"] as const;
export type GatePolicy = (typeof GATE_POLICIES)[number];

/**
 * 채택 형태 (2026-08-14) — **수동 채택 다이얼로그와 같은 값 체계**(8023f6a · store.tsx
 * adoptRecommendation opts). 자동 순방엔 다이얼로그에서 고를 사람이 없어 규칙에 미리 담는다.
 * 값 체계가 갈라지면 화면·서버가 서로 다른 말을 하게 되므로 이름·값을 그대로 쓴다.
 */
export const RULE_ORIENTATIONS = ["portrait", "landscape"] as const;
export type RuleOrientation = (typeof RULE_ORIENTATIONS)[number];
export const RULE_REFRAMES = ["ai", "none"] as const;
export type RuleReframe = (typeof RULE_REFRAMES)[number];
/**
 * 썸네일 생성 방식 (2026-08-16).
 *   ai    — 서사 기획 + 등록 인물 누끼로 모델이 그린다. **인물 등록이 선행**돼야 한다.
 *   frame — 실제 영상 프레임 + 자막. 인물 등록 불필요 · 얼굴이 원본 그대로.
 * 무인 경로의 기본은 frame 이다 — ai 는 캐스트 미등록 회차에서 한 장도 못 만든다.
 */
export const RULE_THUMBNAIL_MODES = ["ai", "frame"] as const;
export type RuleThumbnailMode = (typeof RULE_THUMBNAIL_MODES)[number];
export const DEFAULT_RULE_THUMBNAIL_MODE: RuleThumbnailMode = "frame";

export type RuleState = "running" | "record_only" | "paused";

export interface AutomationRule {
  id: string;
  programId: string;
  platform: string;
  accountId: string;
  mediaKind: RuleMediaKind;
  criterion: RuleCriterion;
  gatePolicy: GatePolicy;
  /** 시간대 자유 문자열 ("방영 익일 10시" · "수시"). 표시·스케줄 힌트. */
  window: string;
  enabled: boolean;
  /** 렌더 템플릿 (assets/shorts-template 이름). 미지정 = 프로그램 장르 자동. */
  templateId?: string;
  /**
   * 템플릿 위치 미세조정(%·px) — 자동배포 화면 슬라이더. 시드 기본값 위에 덮인다.
   *
   * 자막(subtitle*)·자막 on/off(subtitles)도 **여기 layout JSONB 안에** 함께 산다. automation_rule
   * 에 자막 전용 컬럼을 새로 두지 않고(마이그레이션 없이 라운드트립) 이 JSONB 로 흘린다 —
   * layout 은 이미 route→upsert→listAutomationRules→순방까지 통짜로 오간다. 위치·크기·색은
   * 서버 렌더의 caption* 로 옮겨지고(factory.autoEditorState), on/off 는 captionsOn 이 된다.
   */
  layout?: {
    titleY?: number; channelIconY?: number; channelBoxY?: number; channelIconSize?: number;
    /** 제목 강조색(#RRGGBB) — 미지정 = 템플릿 accent 색(표준=청록). 렌더 titleLines 강조 줄 색으로. */
    titleColor?: string;
    /** 자막 켜기 — 기본 true(하위호환). false 면 자동 클립이 captionsOn=false 로 렌더된다. */
    subtitles?: boolean;
    /** 자막 세로 위치(% · 화면 하단 기준 · 서버 렌더 capMV 와 같은 축). 기본 14. */
    subtitleY?: number;
    /** 자막 글자 크기(% · 화면 높이 기준 · 서버 CAPTION_PCT 와 같은 축). 기본 4.4. */
    subtitleSize?: number;
    /** 자막 색(#RRGGBB). 기본 #FFFFFF. */
    subtitleColor?: string;
  };
  // ── 다중 확장 (2026-08-12) — 배열이 있으면 배열이 정본, 없으면 단수 폴백 ──
  /** 여러 프로그램. 없으면 [programId]. */
  programIds?: string[];
  /** 여러 채널. 없으면 [{platform, accountId}]. */
  channels?: { platform: string; accountId: string }[];
  /** 채널당 하루 게시 할당량 — 채워질 때까지 순방마다 계속 배포. 기본 3. */
  dailyQuota?: number;
  /** 활동 시간창(KST 시각). 기본 9~22 — 밖에서는 배포하지 않는다. */
  activeStart?: number;
  activeEnd?: number;
  /**
   * 발행 요일 (ISO · 1=월 … 7=일). 비었으면 **매일**(기존 동작).
   * 편성이 "월화수목금" 인 프로그램이 주말에도 나가면 채널 성격이 흐려진다.
   */
  weekdays?: number[] | null;
  /**
   * 발행 시각 슬롯 (KST 벽시계 "HH:MM"). 비었으면 슬롯 없음 = 활동 시간창 + 할당량 방식.
   *
   * 슬롯이 있으면 **그 시각이 지나야 그만큼 나간다** — 17:00·20:00·22:00 이면 20:30 에
   * 오늘 누적 2건까지다. 순방이 5~15분마다 도는 구조 위에서 "정각에 한 건" 을 표현하는
   * 가장 단순한 방법이고, 순방이 한 번 밀려도 다음 순방이 밀린 몫을 따라잡는다.
   */
  slots?: string[] | null;
  /** 채택 방향 — 수동 채택과 같은 값. 미지정 = 기존처럼 추천 kind 로 결정(하위호환). */
  orientation?: RuleOrientation | null;
  /** 'ai' = 세로형 채택 직후 AI 리프레임(clip.reframe) 큐잉. 세로형일 때만 의미. */
  reframe?: RuleReframe | null;
  /** 썸네일 생성 방식. 미지정 = frame(안전한 쪽 · 인물 등록 없이도 나온다). */
  thumbnailMode?: RuleThumbnailMode | null;
}

/** 규칙의 프로그램 목록 — 다중이 있으면 다중, 없으면 단수 폴백. */
export function rulePrograms(rule: AutomationRule): string[] {
  return rule.programIds?.length ? rule.programIds : [rule.programId];
}

/** 규칙의 채널 목록 — 다중이 있으면 다중, 없으면 단수 폴백. */
export function ruleChannels(rule: AutomationRule): { platform: string; accountId: string }[] {
  return rule.channels?.length ? rule.channels : [{ platform: rule.platform, accountId: rule.accountId }];
}

/**
 * 규칙의 활동 시간창(KST 시각) — 기본 9~22.
 *
 * 판정(inActiveWindow)과 문구(ruleIdleNote 의 off_hours)가 **같은 기본값**을 봐야 한다.
 * 두 벌이 되면 "9~22시 밖" 이라고 적어 놓고 다른 시간에 도는 일이 생긴다.
 */
export function ruleWindow(rule: Pick<AutomationRule, "activeStart" | "activeEnd">): { start: number; end: number } {
  return {
    start: Number.isFinite(rule.activeStart) ? Number(rule.activeStart) : 9,
    end: Number.isFinite(rule.activeEnd) ? Number(rule.activeEnd) : 22,
  };
}

// ── 발행 요일 · 발행 시각 슬롯 (2026-08-20) ─────────────────────────────────────
// 화면이 "월화수목금 · 17:00 20:00 22:00" 을 받는데 순방이 그걸 안 보면, 사용자는 지키지도
// 않는 편성을 설정하고 지켜진다고 믿는다. 판정을 여기 순수 함수로 두고 순방이 그대로 쓴다.

/** 요일 정규화 — ISO 1..7 만 남기고 오름차순 중복 제거. 비면 null(= 매일). */
export function ruleWeekdays(rule: Pick<AutomationRule, "weekdays">): number[] | null {
  const raw = Array.isArray(rule.weekdays) ? rule.weekdays : [];
  const days = [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))]
    .sort((a, b) => a - b);
  return days.length ? days : null;
}

/** KST 기준 오늘의 ISO 요일 (1=월 … 7=일). */
export function kstWeekday(now = new Date()): number {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(now);
  // Intl 의 일요일 시작을 ISO(월=1)로 옮긴다.
  const iso: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return iso[short] ?? 1;
}

/** 오늘이 이 규칙의 발행 요일인가. 요일 미지정이면 언제나 참(기존 동작). */
export function isPublishDay(rule: Pick<AutomationRule, "weekdays">, now = new Date()): boolean {
  const days = ruleWeekdays(rule);
  return days === null || days.includes(kstWeekday(now));
}

/** 슬롯 정규화 — "HH:MM" 만 남기고 시각순 중복 제거. 비면 빈 배열(= 슬롯 없음). */
export function ruleSlots(rule: Pick<AutomationRule, "slots">): string[] {
  const raw = Array.isArray(rule.slots) ? rule.slots : [];
  const ok = raw
    .map((s) => String(s).trim())
    .filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
  return [...new Set(ok)].sort();
}

/** KST 벽시계 분(0~1439). 슬롯 비교의 기준축. */
export function kstMinutes(now = new Date()): number {
  const [h, m] = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now).split(":").map(Number);
  return h * 60 + m;
}

/** 오늘 지금까지 지난 슬롯 수 — 그만큼이 오늘 이 시각까지 허용되는 누적 발행 수다. */
export function slotsElapsed(slots: string[], now = new Date()): number {
  const cur = kstMinutes(now);
  return slots.filter((s) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m <= cur;
  }).length;
}

/**
 * 오늘 이 채널에 **지금** 허용되는 누적 발행 수.
 *
 * 슬롯이 있으면 지난 슬롯 수(정각 편성), 없으면 하루 할당량(기존 동작).
 * 순방은 여기서 이미 나간 건수를 빼서 남은 몫을 정한다.
 */
export function allowedToday(rule: Pick<AutomationRule, "slots" | "dailyQuota">, now = new Date()): number {
  const slots = ruleSlots(rule);
  if (slots.length) return slotsElapsed(slots, now);
  return Number(rule.dailyQuota) > 0 ? Number(rule.dailyQuota) : 3;
}

/** 하루 발행 수 — 슬롯이 있으면 슬롯 수가 곧 하루 발행 수다. */
export function perDayCount(rule: Pick<AutomationRule, "slots" | "dailyQuota">): number {
  const slots = ruleSlots(rule);
  if (slots.length) return slots.length;
  return Number(rule.dailyQuota) > 0 ? Number(rule.dailyQuota) : 3;
}

const WEEKDAY_LABEL = ["", "월", "화", "수", "목", "금", "토", "일"];

/** 요일 배열 → "월화수목금". 비면 "매일" — 문구가 `undefined` 로 새지 않게 여기서 막는다. */
export function formatWeekdays(days: number[] | null | undefined): string {
  if (!days?.length) return "매일";
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAY_LABEL[d] ?? "").join("");
}

/** 한 달 평균 주 수 — 52주/12개월. 화면의 "월 환산" 이 이 상수를 쓴다. */
export const WEEKS_PER_MONTH = 52 / 12;

/**
 * 월 예상 발행 건수 — 요일 수 × 하루 발행 수 × 채널 수 × 월평균 주 수.
 *
 * **판정과 같은 함수에서 나와야 한다.** 화면이 따로 계산하면 "월 66건" 이라 적어 놓고
 * 실제로는 다른 수가 나가는 상태가 되고, 그게 곧 청구 예상과 어긋난다.
 */
export function monthlyPublishEstimate(
  rule: Pick<AutomationRule, "weekdays" | "slots" | "dailyQuota" | "channels" | "platform" | "accountId">,
): { perWeek: number; perMonth: number; perDay: number; days: number; channels: number } {
  const days = ruleWeekdays(rule as AutomationRule)?.length ?? 7;
  const perDay = perDayCount(rule);
  const channels = Math.max(1, ruleChannels(rule as AutomationRule).length);
  const perWeek = days * perDay * channels;
  return { perWeek, perMonth: Math.round(perWeek * WEEKS_PER_MONTH), perDay, days, channels };
}

/**
 * 지금이 활동 시간창(KST) 안인가. end 는 배타 — 9~22 면 09:00:00 ≤ t < 22:00:00.
 * start·end 가 같으면 24시간으로 본다 (창 없음 의미).
 */
export function inActiveWindow(rule: AutomationRule, now = new Date()): boolean {
  const { start, end } = ruleWindow(rule);
  if (start === end) return true;
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", hour: "numeric", hour12: false,
  }).format(now));
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * 실업로드까지 가는 채널인가 — 규칙 상태·안내 문구의 기준.
 *
 * **`publish-guard.ts` 의 `channelPublishMode` 와 같은 목록이어야 한다.** 예전엔 여기만
 * "youtube 아니면 기록만" 이었는데, 네이버는 실제로 브라우저 자동화로 **올라간다**.
 * 그래서 "배포 기록만 남습니다" 라고 안내한 채널에 영상이 나가는 안전 문구 역전이 됐다.
 * 게이트가 꺼져 있으면 실제로는 기록만 되지만, 그건 켜고 끄는 축이라 상태가 아니라
 * 배너로 알린다(자동화 화면 gates).
 */
const UPLOAD_PLATFORMS = new Set(["youtube", "navertv", "naverclip", "instagram", "facebook", "tiktok"]);

/**
 * 규칙 생성 시 상태 분기 (F6).
 * 실업로드 채널이면 running, 상태 기록만 하는 채널(Meta·SMR 스텁 등)은 `기록만`.
 */
export function initialRuleState(platform: string, enabled = true): RuleState {
  if (!enabled) return "paused";
  return UPLOAD_PLATFORMS.has(platform) ? "running" : "record_only";
}

/** 규칙 생성 토스트 문구 (F6 ⚑ — 기록만 하는 채널은 반드시 알린다). */
export function ruleCreatedNotice(platform: string): string {
  return UPLOAD_PLATFORMS.has(platform)
    ? "규칙이 실행 중입니다 — 다음 순방부터 적용됩니다."
    : "이 채널은 배포 기록만 남습니다 — 실제 게시는 담당자가 해당 앱에서 직접 해야 합니다.";
}

// ── 03 미디어 생성: 어떤 추천을 채택할 것인가 ───────────────────────────────────

export interface Candidate {
  id: string;
  kind: string;
  score100?: number | null;
  status?: string | null;
}

/** top3 기준의 상한 — **회차(에피소드)당** 총 3건이지, 순방당 3건이 아니다. */
export const TOP3_CAP = 3;

/**
 * 이 구간의 쇼츠가 이미 존재하는가 — **재분석 중복 채택 방지.**
 *
 * 회차를 재분석하면 추천이 새 ID 로 다시 생성돼 "채택됨" 표식이 사라진다. 그대로 두면
 * 이미 내보낸 구간이 새 추천으로 또 채택돼 같은 쇼츠가 중복 배포된다. 판정은 결정론 —
 * 겹침 길이가 짧은 쪽 길이의 절반을 넘으면 같은 구간으로 본다. 수동 채택 클립도 존중한다:
 * 사람이 이미 만든 구간을 자동이 또 만들면 안 되는 건 마찬가지다.
 */
export function overlapsExistingClip(
  rec: { startTime?: number | null; endTime?: number | null },
  clips: Array<{ startTime?: number | null; endTime?: number | null }>,
): boolean {
  const rs = Number(rec.startTime);
  const re = Number(rec.endTime);
  if (!Number.isFinite(rs) || !Number.isFinite(re) || re <= rs) return false;
  for (const c of clips) {
    const cs = Number(c.startTime);
    const ce = Number(c.endTime);
    if (!Number.isFinite(cs) || !Number.isFinite(ce) || ce <= cs) continue;
    const ov = Math.min(re, ce) - Math.max(rs, cs);
    if (ov > 0 && ov / Math.min(re - rs, ce - cs) > 0.5) return true;
  }
  return false;
}

/**
 * 이 추천이 규칙의 미디어 종류에 맞는가.
 *
 * selectCandidates 안에 인라인으로 있던 판정을 뽑았다 — 순방이 "왜 아무것도 안 했나" 를
 * 세려면 종류에서 몇 개가 떨어졌는지 알아야 하는데, 거기서 판정을 한 벌 더 쓰면 두 벌이
 * 갈라져 로그가 채택과 다른 말을 하게 된다.
 */
export function matchesMediaKind(rule: AutomationRule, c: Candidate): boolean {
  if (rule.mediaKind === "both") return true;
  return rule.mediaKind === "short" ? c.kind === "short" : c.kind !== "short";
}

/**
 * 규칙 조건을 통과한 추천만 고른다 (F6 03단계).
 * 이미 판단된 것(채택·거절)은 다시 잡지 않는다 — 사람이 거절한 걸 자동이 되살리면 안 된다.
 *
 * `adoptedCount` = 이 규칙이 **같은 회차에서 이미 채택한 수**(클립의 automationRuleId ·
 * episodeId 로 센다). top3 만 본다 — 채택하면 후보가 pending 풀에서 빠지므로, 이걸 안 빼면
 * 순방마다 "새 상위 3건"이 또 뽑혀 상한이 없는 것과 같다(수 시간이면 추천 전량이 클립화).
 */
export function selectCandidates(
  rule: AutomationRule,
  candidates: Candidate[],
  adoptedCount = 0,
): Candidate[] {
  const undecided = candidates.filter((c) => (c.status ?? "pending") === "pending");

  const byKind = undecided.filter((c) => matchesMediaKind(rule, c));

  if (rule.criterion === "top3") {
    // 회차당 잔여 상한. 이미 3건 채웠으면 아무것도 뽑지 않는다.
    const remaining = Math.max(0, TOP3_CAP - Math.max(0, Math.trunc(adoptedCount)));
    if (remaining === 0) return [];
    // 점수가 없는 후보는 상위 N 에서 뺀다 — 0점으로 치면 아무거나 올라온다.
    return byKind
      .filter((c) => typeof c.score100 === "number")
      .sort((a, b) => (b.score100 ?? 0) - (a.score100 ?? 0))
      .slice(0, remaining);
  }

  const floor = rule.criterion === "score85" ? 85 : 80;
  // 점수가 없으면 기준을 만족한다고 볼 수 없다. 모르면 안 내보낸다.
  const scored = byKind.filter((c) => typeof c.score100 === "number");
  const passed = scored.filter((c) => (c.score100 as number) >= floor);
  if (passed.length > 0) return passed;

  // ── 폴백: 절대 점수 기준이 한 건도 안 통과 → **한 영상이 통째로 비지 않게 최고 1건 보장** ──
  // 쇼츠 score100 은 회차 내 백분위라 42~72 대에 눌려 80 을 못 넘는 구조다(POST /api/automation/rules
  // 주석 · 실측 20편 42.1~72.6). 그래서 사용자가 쇼츠에 score80 을 걸면 그 회차가 통째로 안 나가는
  // 일이 잦았다(사용자 2026-08-19). **회차당 이미 채택분이 있으면(≥1) 폴백하지 않는다** — 이미 뭔가
  // 나갔으니 강제하지 않는다. 결과적으로 "점수 하한이되, 회차마다 최소 최고 한 편"이 된다(클립
  // 81~83 은 정상 통과라 이 폴백을 거의 안 탄다). 점수 없는 후보는 폴백 대상이 아니다(scored 만).
  if (Math.max(0, Math.trunc(adoptedCount)) > 0 || scored.length === 0) return [];
  return [scored.reduce((best, c) => ((c.score100 ?? 0) > (best.score100 ?? 0) ? c : best))];
}

// ── 04 게이트 확인 ───────────────────────────────────────────────────────────────

export interface GateSnapshot {
  allowed: boolean;
  state: string;
  reason: string;
}

export type StepDecision =
  | { action: "publish"; reason: "" }
  | { action: "hold"; reason: string; needsHuman: true }
  | { action: "skip"; reason: string };

/**
 * 한 미디어를 지금 내보낼지 결정한다 (F6 04→05).
 *
 * `approvedBy` 는 사람이 승인한 기록이다. 정책이 `approve_first` 면 게이트를 통과했어도
 * 이게 없으면 나가지 않는다.
 */
export function decidePublish(input: {
  rule: AutomationRule;
  gate: GateSnapshot;
  /** 사람이 승인했는가 (approve_first 정책에서만 본다). */
  approved: boolean;
  /** 이미 보류 처리됐고 아직 사람이 확정하지 않았는가. */
  heldAwaitingHuman: boolean;
}): StepDecision {
  const { rule, gate } = input;

  if (!rule.enabled) return { action: "skip", reason: "규칙이 멈춰 있습니다." };

  // 게이트가 먼저다. 어떤 정책도 이걸 넘지 못한다 (F6 Invariant).
  if (!gate.allowed) {
    return { action: "hold", reason: gate.reason || "게이트 미통과", needsHuman: true };
  }

  // 보류된 건은 **사람이 확정해야** 다시 잡힌다. 게이트가 열렸다고 저절로 나가지 않는다.
  if (input.heldAwaitingHuman) {
    return { action: "hold", reason: "보류 상태입니다 — 사람이 확정해야 다음 순방에 다시 잡힙니다.", needsHuman: true };
  }

  if (rule.gatePolicy === "approve_first" && !input.approved) {
    return { action: "hold", reason: "게시 전 사람 승인이 필요한 규칙입니다.", needsHuman: true };
  }

  return { action: "publish", reason: "" };
}

// ── 순방(cycle) ─────────────────────────────────────────────────────────────────

/**
 * 크레딧 소진 시 순방 정지 사유 — runAutomationCycle 과 GET /api/automation 이
 * **같은 문구**를 쓴다. 두 벌이 되면 화면과 로그가 다른 말을 해서 원인 추적이 갈라진다.
 */
export const CREDIT_IDLE_REASON = "크레딧 부족 — 충전 필요";

/**
 * 마지막 순방 시각을 담는 automation_setting 키 — runAutomationCycle 이 매 순방 심박을 찍고
 * GET /api/automation 이 그걸 읽어 "마지막 확인 N분 전 · 다음 예정" 을 그린다. rule_run 은
 * dedupe·하루한줄 가드 때문에 한 줄도 안 남는 순방이 흔해(유휴·전부 스킵), 로그 최신행만으론
 * "순방이 언제 돌았는지" 를 알 수 없다 — 순방 자체의 시각을 따로 박는다. 두 벌이 되면 갈라지므로
 * 여기 한 곳에 둔다(PAUSE_KEY 와 같은 이유).
 */
export const LAST_CYCLE_KEY = "automation.lastCycleAt";

export interface CycleInput {
  /** 전역 일시정지 상태. */
  paused: boolean;
  rules: AutomationRule[];
}

export interface CyclePlan {
  /** 이번 순방에서 평가할 규칙. */
  rules: AutomationRule[];
  /** 아무것도 안 하는 이유 (있으면 로그에 남긴다). */
  idleReason: string;
}

/**
 * 이번 순방에 무엇을 할지.
 *
 * **규칙이 없으면 아무것도 하지 않는다** (F6 Invariant). 빈 배열을 "전체 대상"으로
 * 해석하지 않는다 — 그 실수 한 번이면 손대지 않은 프로그램들이 배포된다.
 *
 * 일시정지는 **새 회차를 잡지 않는 것**이지 진행 중인 걸 죽이는 게 아니다.
 * 이미 큐에 들어간 건은 그대로 나간다(F6 전역 토글).
 */
export function planCycle(input: CycleInput): CyclePlan {
  if (input.paused) return { rules: [], idleReason: "일시정지 상태 — 새 회차를 잡지 않습니다." };
  if (input.rules.length === 0) {
    return { rules: [], idleReason: "규칙이 없습니다 — 자동 배포는 규칙이 있어야만 동작합니다." };
  }
  const active = input.rules.filter((r) => r.enabled);
  if (active.length === 0) return { rules: [], idleReason: "실행 중인 규칙이 없습니다." };
  return { rules: active, idleReason: "" };
}

// ── 순방이 아무것도 안 했을 때: 사유 판정 ────────────────────────────────────────

/**
 * 크레딧 소진으로 순방이 통째로 멈췄다는 **실행 로그** 문구.
 *
 * 배너(`CREDIT_IDLE_REASON`)는 "지금 상태" 라서 지나간 시간을 설명하지 못한다 — 어제 왜
 * 아무것도 안 나갔는지는 로그에만 남길 수 있다. 두 문구가 같은 어휘로 시작하게 상수를
 * 이어 붙인다: 배너와 로그가 다른 말을 하면 원인 추적이 두 갈래로 갈라진다.
 *
 * ⚠️ 이 문자열 자체가 dedupe 키다(hasRunNote 의 detail 일치). 잔액·시각 같은 변동값을
 * 넣으면 순방(15분)마다 새 줄이 쌓여 실행 로그 창(최근 50건)을 이 줄로 덮는다.
 */
export const CREDIT_STOP_NOTE =
  `${CREDIT_IDLE_REASON} — 잔액이 0 이하라 이번에는 채택도 게시도 하지 않았습니다.`
  + " 충전하면 다음 확인 때 자동으로 다시 시작합니다.";

/**
 * 회차 분석이 지금 어느 상태인가 — 순방이 "왜 아무 일도 안 했나" 를 세는 근거.
 *
 * ⚠️ **blocked 를 analyzing 으로 세면 안 된다.** 크레딧이 모자라 분석을 못 건 회차는 잡이
 * 큐에 들어간 적이 **없어서 영원히 안 끝난다.** 그걸 "분석 중" 으로 세면 순방이
 * "끝나면 다음 확인 때 자동으로 이어집니다" 라고 말하고, 운영자는 오지 않을 완료를 기다린다 —
 * 이 리포 최빈 실패모드(조용한 정지)의 교과서적 형태다.
 *
 * 판정 근거가 둘인 이유: 업로드 경로(index.ts)는 `pipeline.blockedReason` 에 사유를 남기지만,
 * 유튜브 가져오기 경로(worker.ts)는 `note` 에만 남기고 stageStatus 는 idle 이라 **정상 대기와
 * 글자 그대로 구분이 안 된다.** 그래서 사유 문구(크레딧·충전)까지 본다.
 */
export type EpisodeAnalysisState = "blocked" | "analyzing" | "failed" | "analyzed";

export function episodeAnalysisState(
  pipeline?: { stageStatus?: string | null; blockedReason?: string | null; note?: string | null } | null,
): EpisodeAnalysisState {
  const stage = String(pipeline?.stageStatus ?? "");
  // error 는 **분석이 돌다가** 실패한 것이다(content-pipeline 이 blockedReason 도 함께 쓴다) —
  // 큐잉조차 안 된 blocked 와 사람이 할 일이 다르므로 먼저 가른다.
  if (stage === "error") return "failed";
  if (String(pipeline?.blockedReason ?? "").trim()) return "blocked";
  if ((stage === "idle" || stage === "warn") && /크레딧|충전/.test(String(pipeline?.note ?? ""))) return "blocked";
  if (stage === "idle" || stage === "progress") return "analyzing";
  return "analyzed";
}

/**
 * 규칙 하나가 이번 순방에 아무 일도 안 한 사유. 하나만 고른다 —
 * 이유를 여러 개 늘어놓으면 어디부터 손대야 할지 모른다(channel-rules 의 eligibility 와 같은 원칙).
 *
 * 게시 단계 사유(render_*·gate_off·quota_done…)가 여기 함께 사는 이유: 그 사유들은 실행
 * 로그에 (클립,채널)당 한 줄로 눌러 두는데, 눌린 뒤에는 **그 규칙이 왜 멈춰 있는지 아무도
 * 말하지 않는다.** 규칙 단위 하루 한 줄로 이어 주는 자리가 여기다.
 */
export const RULE_IDLE_CODES = [
  "off_hours", "off_day",
  "no_episode", "analysis_blocked", "analysis_failed", "analyzing",
  "render_stopped", "gate_off", "publish_failed", "held_waiting", "vague_account",
  "channel_rule", "quota_done",
  "top3_cap", "score_blocked", "kind_mismatch", "overlap",
  "render_waiting", "meta_waiting",
  "all_sent", "no_pending",
] as const;
export type RuleIdleCode = (typeof RULE_IDLE_CODES)[number];

/** 규칙 하나를 평가하며 모은 관측치 — 순방(automation-cycle)이 채운다. */
export interface RuleIdleObservation {
  /** 지금이 활동 시간창 밖인가 — 참이면 규칙 평가 자체를 건너뛴 것이라 나머지는 0이다. */
  outOfWindow: boolean;
  /** 활동 시간창(KST 시각) — 문구에 싣는다. 규칙 설정이라 하루 안에 저절로 안 변한다. */
  activeStart: number;
  activeEnd: number;
  /** 오늘이 발행 요일이 아닌가 — 참이면 시간창과 마찬가지로 규칙 평가를 통째로 건너뛴 것이다. */
  offDay?: boolean;
  /** 설정된 발행 요일(ISO). 문구에 싣는다 — 규칙 설정이라 하루 안에 안 바뀐다. */
  weekdays?: number[] | null;
  /** 이 규칙의 프로그램에 속한 회차 수. */
  episodes: number;
  /** 분석이 끝난(done/warn) 회차 수. */
  analyzed: number;
  /** 분석이 아직 도는(idle/progress) 회차 수. */
  analyzing: number;
  /** 분석이 error 로 끝난 회차 수. */
  analysisFailed: number;
  /** 분석 잡이 **큐잉조차 안 된** 회차 수(크레딧 부족 등) — 기다려도 안 끝난다. */
  analysisBlocked: number;
  /** 아직 사람이 판단하지 않은(pending) 추천 수. */
  pending: number;
  /** 그중 규칙의 미디어 종류와 맞는 수. */
  kindMatched: number;
  /** 종류는 맞지만 기존 클립과 구간이 겹쳐 제외된 수. */
  overlapped: number;
  /** 종류·겹침을 통과했지만 채택 기준에 걸린 수. */
  scoreBlocked: number;
  /**
   * 그중 **점수 자체가 없는** 수.
   *
   * 점수 없는 추천은 세 기준(80·85·상위 3건) 어디에서도 안 잡힌다(selectCandidates) —
   * "기준을 낮추면 잡힙니다" 라고 안내하면 사용자가 그대로 해도 그대로 0건이다.
   * 기준을 바꿔서 풀리는 것과 재분석해야 풀리는 것을 여기서 가른다.
   */
  scoreMissing: number;
  /** top3 회차당 상한에 이미 닿은 회차 수(분석 끝난 회차 중). */
  cappedEpisodes: number;
  /** 이 규칙의 클립이 하나 이상 있고, 전부 연결된 채널 전부로 나갔는가. */
  clipsAllSent: boolean;
  /** 이번 순방에서 채택한 수. */
  adopted: number;
  // ── 게시 단계에서 마주친 상태 (전부 "이번 순방에 하나라도 있었나") ──
  /** 렌더가 확정 실패해 자동 게시를 멈춘 클립을 만났다. */
  renderStopped: boolean;
  /** 실업로드 게이트(env)가 꺼져 있어 보내지 못한 채널이 있다. */
  gateOff: boolean;
  /** 직전 배포가 실패해 자동 재시도를 하지 않는 건이 있다(F4-4). */
  publishFailed: boolean;
  /** 사람 승인·보류 해제를 기다리는 건이 있다. */
  heldWaiting: boolean;
  /** 계정 식별자가 없는 옛 배포 기록 때문에 건너뛴 클립이 있다. */
  vagueAccount: boolean;
  /** 채널 규칙(길이·화면비 등)에 맞지 않아 게시하지 못한 클립이 있다. */
  channelBlocked: boolean;
  /** 오늘 하루 할당량을 다 쓴 채널이 있다. */
  quotaDone: boolean;
  /** 렌더가 끝나기를 기다리는 클립이 있다. */
  renderWaiting: boolean;
  /** 채널별 메타데이터 생성을 기다리는 클립이 있다. */
  metaWaiting: boolean;
  criterion: RuleCriterion;
  mediaKind: RuleMediaKind;
}

/**
 * 자동화 화면(CRIT_LABEL·KIND_LABEL)과 **같은 어휘**. 로그와 화면이 다른 말을 하면 안 된다.
 *
 * ⚠️ 미디어 종류는 화면이 "숏폼" 이라고 부른다(automation/page.tsx KIND_LABEL). 여기만 "쇼츠"
 * 였던 적이 있는데, 같은 설정을 두 이름으로 부르면 사용자는 로그의 사유가 자기가 고른 설정을
 * 가리키는지조차 모른다. 화면 표기를 정본으로 삼는다.
 */
const CRITERION_LABEL: Record<RuleCriterion, string> = {
  score80: "점수 80 이상", score85: "점수 85 이상", top3: "상위 3건",
};
const MEDIA_KIND_LABEL: Record<RuleMediaKind, string> = {
  short: "숏폼", clip: "클립", both: "숏폼+클립",
};

/**
 * 왜 이 규칙에서 아무 일도 안 났는지 — 한 줄로 고른다. 없으면(=일을 했으면) null.
 *
 * **고르는 순서에 근거가 있다.** 순서가 흔들리면 같은 상황에서 로그가 매번 다른 말을 한다.
 *  ⓪ 활동 시간창 밖이면 평가 자체를 안 했다 — 다른 사유를 말할 근거가 없다.
 *  ① 채택했으면 사유가 없다 — 할 일을 했다.
 *  ② 상류가 통째로 비었으면 그것부터(회차 없음). 하류 사유는 존재할 수가 없다.
 *  ③ **분석이 끝난 회차가 하나도 없으면 하류 사유는 전부 공허하다.** 이 가드가 없으면
 *     "채택할 추천이 없습니다" 라는 **틀린 사유**가 나간다 — 진짜 원인은 분석 실패/미시작/진행중이다.
 *  ④ 그다음이 **게시 단계에서 사람 손이 필요한 것**(렌더 확정 실패 · 게이트 OFF · 승인 대기 …).
 *     이미 만든 클립이 못 나가고 있는데 "채택할 추천이 없습니다" 라고 말하면 정반대를 보게 된다.
 *  ⑤ 그다음이 **사람이 규칙을 바꾸면 풀리는 것**(상한 → 기준 → 종류 → 겹침).
 *  ⑥ 시간이 저절로 풀어 주는 사유(렌더·메타 대기)를 사람 몫보다 뒤에 두는 게 이 순서의 근거다.
 *  ⑦ 마지막이 정상 정지(다 나감) → 기본값(추천 없음).
 *
 * ⚠️ detail 문구에 **변동 숫자를 넣지 않는다.** 이 문자열이 곧 dedupe 키라서(hasRunNote),
 * 카운트가 섞이면 순방마다 새 줄이 쌓여 실행 로그가 이 줄로 덮인다. 문구에 들어가는 숫자는
 * 규칙 설정(기준 점수·활동 시간 같은)뿐이다 — 하루 안에 저절로 바뀌지 않는다.
 */
export function ruleIdleNote(o: RuleIdleObservation): { code: RuleIdleCode; detail: string } | null {
  // 활동 시간창 밖 — 예전엔 여기서 로그가 **0줄**이라 하루 11~14시간이 통째로 비었다.
  // 아침에 "밤새 올린 회차가 왜 안 나갔지" 를 볼 때, 순방이 안 돈 건지 워커가 죽은 건지
  // 구분할 근거가 제품 안에 없었다.
  if (o.outOfWindow) {
    // 값이 비면 `활동 시간(undefined~undefined시)` 이 그대로 운영자 화면에 뜬다.
    // 타입이 막아 주지만, 이 문구는 **로그 dedupe 키**라 한 번 새면 그 모양으로 하루가 굳는다.
    const win = ruleWindow({ activeStart: o.activeStart, activeEnd: o.activeEnd });
    return {
      code: "off_hours",
      detail: `활동 시간(${win.start}~${win.end}시) 밖이라 이번에는 아무것도 하지 않았습니다`
        + " — 활동 시간이 되면 자동으로 이어서 확인합니다.",
    };
  }

  // 발행 요일이 아닌 날 — 시간창과 같은 이유로 하루 한 줄은 남긴다. 이게 없으면 토요일에
  // "왜 아무것도 안 나갔지" 를 볼 때 설정 때문인지 고장인지 구분할 근거가 로그에 없다.
  if (o.offDay) {
    return {
      code: "off_day",
      // ⚠️ 이 문구는 dedupe 키다 — 오늘 요일 같은 **변동 값을 넣지 않는다**(규칙 설정만).
      detail: `오늘은 발행 요일(${formatWeekdays(o.weekdays)})이 아니라 아무것도 하지 않았습니다`
        + " — 다음 발행 요일에 자동으로 이어서 확인합니다.",
    };
  }

  if (o.adopted > 0) return null;

  if (o.episodes === 0) {
    return { code: "no_episode", detail: "이 규칙의 프로그램에 회차가 없습니다 — 회차를 올리면 다음 확인 때 잡습니다." };
  }

  if (o.analyzed === 0) {
    // 순서 주의: **큐잉조차 안 된 회차(blocked)가 먼저다.** 기다리면 끝나는 것(analyzing)과
    // 섞으면 영원히 안 오는 완료를 기다리게 된다.
    if (o.analysisBlocked > 0) {
      return {
        code: "analysis_blocked",
        // ⚠️ "충전한 뒤에 시작됩니다" 라고 쓰면 **충전만 하면 저절로 돈다**로 읽힌다. 충전은
        // 아무 잡도 큐잉하지 않는다 — 사람이 다시 눌러야 시작한다. 조용한 정지의 반복이다.
        detail: "회차 분석이 시작되지 않았습니다 — 회차 화면에서 분석을 시작해 주세요."
          + " 잔액이 모자라면 충전한 뒤 다시 시작해 주세요 (충전만으로는 시작되지 않습니다).",
      };
    }
    return o.analysisFailed > 0
      ? { code: "analysis_failed", detail: "회차 분석이 실패해 채택할 추천이 없습니다 — 회차 화면에서 분석을 다시 시작해 주세요." }
      : { code: "analyzing", detail: "회차 분석이 아직 끝나지 않았습니다 — 끝나면 다음 확인 때 자동으로 이어집니다." };
  }

  // ── 게시 단계: 이미 만든 클립이 못 나가고 있다 (사람 손이 필요한 것부터) ──
  if (o.renderStopped) {
    return {
      code: "render_stopped",
      // "끝나지 않아" 는 진행 중으로 읽혀 바로 아래 render_waiting(렌더 대기)과 구분이 안 된다.
      // 이건 **확정 실패**다 — 기다려도 저절로 안 끝난다.
      detail: "렌더가 실패해 자동 게시를 멈춘 클립이 있습니다"
        + " — 편집기에서 확정(렌더)이 되는지 확인해 주세요. 되면 다음 확인 때 이어서 게시합니다.",
    };
  }

  if (o.gateOff) {
    return {
      code: "gate_off",
      detail: "실제 업로드가 꺼져 있어 이 규칙의 채널로는 보내지 못했습니다"
        + " — 담당자에게 업로드 설정을 켜 달라고 요청해 주세요.",
    };
  }

  if (o.publishFailed) {
    return {
      code: "publish_failed",
      detail: "직전 배포가 실패한 건이 있습니다 — 자동으로 다시 쏘지 않습니다."
        + " 배포 기록에서 재시도를 눌러 주세요.",
    };
  }

  if (o.heldWaiting) {
    return {
      code: "held_waiting",
      detail: "사람 확인을 기다리는 건이 있습니다 — 승인 대기 목록에서 확정하면 다음 확인 때 나갑니다.",
    };
  }

  if (o.vagueAccount) {
    return {
      code: "vague_account",
      detail: "어느 계정으로 나갔는지 알 수 없는 옛 배포 기록이 있어 건너뛰었습니다"
        + " — 이미 나간 건이면 그대로 두고, 아니면 배포 화면에서 계정을 지정해 발행해 주세요.",
    };
  }

  if (o.channelBlocked) {
    return {
      code: "channel_rule",
      // 다른 사유는 전부 갈 화면을 지목한다(회차 화면·편집기·배포 기록). 여기만 "채널 규칙을
      // 바꾸세요" 라고 해서 어디서 여는지가 없었다 — 채널 규칙은 배포 채널 화면에서 연다.
      detail: "채널 규칙(길이·화면비)에 맞지 않아 게시하지 못한 클립이 있습니다"
        + " — 배포 채널 화면에서 배포 규칙을 바꾸거나, 클립을 편집기에서 손봐 주세요.",
    };
  }

  if (o.quotaDone) {
    return {
      code: "quota_done",
      detail: "오늘 이 규칙 채널의 게시 할당량을 다 썼습니다 — 내일 자정(KST)에 초기화되면 이어서 게시합니다.",
    };
  }

  // 상한은 **모든** 분석 완료 회차가 닿았을 때만 사유가 된다. 한 회차라도 다른 이유로
  // 멈춘 거면 상한 탓이 아니다 — 덜 정확해도 과잉 주장보다 낫다.
  if (o.cappedEpisodes > 0 && o.cappedEpisodes === o.analyzed) {
    return {
      code: "top3_cap",
      detail: "이 규칙이 각 회차에서 뽑을 수 있는 만큼(상위 3건) 이미 채택했습니다"
        + " — 더 내보내려면 채택 기준을 점수 기준으로 바꾸거나 새 회차를 올려 주세요.",
    };
  }

  if (o.scoreBlocked > 0) {
    // ⚠️ **점수가 없는 추천은 기준을 바꿔도 안 잡힌다.** selectCandidates 는 세 기준 모두에서
    // 점수 없는 후보를 뺀다(모르면 안 내보낸다) — 그런데 예전 문구는 그 경우에도
    // "기준을 낮추거나 '상위 3건' 으로 바꾸면 잡힙니다" 라고 안내했다. 사용자가 그대로 해도
    // 결과는 그대로 0건이다. 점수 없음(재분석해야 풀림)과 점수 미달(기준을 바꾸면 풀림)을 가른다.
    if (o.criterion === "top3" || o.scoreMissing >= o.scoreBlocked) {
      return {
        code: "score_blocked",
        detail: "추천에 점수가 없어 채택할 대상을 고르지 못했습니다 — 회차를 다시 분석하면 점수가 채워집니다.",
      };
    }
    return {
      code: "score_blocked",
      detail: `채택 기준(${CRITERION_LABEL[o.criterion]})을 넘는 추천이 없습니다`
        + " — 기준을 낮추거나 '상위 3건' 으로 바꾸면 잡힙니다."
        // 섞여 있으면 두 조치가 다 필요하다. 이 분기는 **개수가 아니라 종류**라 하루에
        // 최대 한 줄 더 늘 뿐이다(dedupe 는 산다).
        + (o.scoreMissing > 0 ? " 점수가 비어 있는 추천은 회차를 다시 분석해야 채워집니다." : ""),
    };
  }

  if (o.kindMatched === 0 && o.pending > 0) {
    return {
      code: "kind_mismatch",
      detail: `이 규칙이 만드는 종류(${MEDIA_KIND_LABEL[o.mediaKind]})에 맞는 추천이 없습니다`
        + " — 규칙의 미디어 종류를 바꾸면 잡힙니다.",
    };
  }

  if (o.overlapped > 0) {
    return {
      code: "overlap",
      detail: "새로 뽑을 구간이 이미 만든 클립과 겹쳐 전부 제외됐습니다 — 같은 장면의 중복 배포를 막는 정상 동작입니다.",
    };
  }

  // 시간이 저절로 풀어 주는 것 — 사람 몫보다 뒤다.
  if (o.renderWaiting) {
    return {
      code: "render_waiting",
      detail: "클립 렌더가 끝나기를 기다리는 중입니다 — 끝나면 다음 확인 때 자동으로 게시합니다.",
    };
  }

  if (o.metaWaiting) {
    return {
      code: "meta_waiting",
      detail: "채널별 제목·설명을 만드는 중입니다 — 끝나면 다음 확인 때 자동으로 게시합니다.",
    };
  }

  if (o.clipsAllSent) {
    return {
      code: "all_sent",
      detail: "이 규칙이 만든 클립은 연결된 채널에 모두 나갔습니다 — 새 회차가 올라오면 이어서 만듭니다.",
    };
  }

  return {
    code: "no_pending",
    detail: "채택할 새 추천이 없습니다 — 새 회차가 올라오거나 회차를 다시 분석하면 잡습니다.",
  };
}

// ── 렌더 안전벨트: 지킬 수 없는 약속을 멈춘다 ──────────────────────────────────

/**
 * 순방 주기 — 프로덕션은 Cloud Scheduler 가 drain 워커를 15분마다 깨운다(worker.ts 기동 팬아웃).
 *
 * 스케줄을 정하는 상수가 아니라 **도달 가능한 재시도 횟수를 계산하는 근거**다. 렌더 재시도는
 * 클립당 순방 한 번(renderTried)이라 재시도 간격이 곧 이 값이다.
 */
export const CYCLE_PERIOD_MS = 15 * 60_000;

/**
 * 첫 실패로부터 이만큼 지나도 못 끝냈으면 포기한다.
 * AI 리프레임의 `REFRAME_STUCK_MS` 와 **같은 값·같은 근거**(하트비트 만료 5분보다 넉넉히).
 */
export const RENDER_STUCK_MS = 30 * 60_000;

/**
 * 렌더 요청이 이만큼 실패하면 자동 게시를 포기한다.
 *
 * ⚠️ 예전 값 5(큐의 기본 maxAttempts)는 **절대 도달하지 않았다.** 재시도 간격이 순방 주기
 * (15분)라 5회째는 60분인데, 30분 정체 벨트(RENDER_STUCK_MS)가 3회째에 먼저 확정시킨다 —
 * 그래서 "렌더가 5회 실패해 멈춥니다" 는 아무도 못 보는 문구였고 테스트도 못 지킬 약속을
 * 고정하고 있었다. 3 = 15분 × 2 = 30분이라 **두 상한이 같은 순간에 닿는다** — 카운터가
 * 실제로 세는 뜻을 갖는다. 주기나 벨트를 바꾸면 이 값도 같이 봐야 한다(테스트가 강제).
 */
export const RENDER_MAX_ATTEMPTS = 3;

/** 렌더 실패의 성격. 이 셋을 안 나누면 "기다리면 되는 것" 과 "영원히 안 되는 것" 이 뒤섞인다. */
export type RenderFailureKind = "permanent" | "waiting" | "retryable";

export type RenderOutcome =
  | { ok: true }
  | {
      ok: false; kind: RenderFailureKind;
      /** 원문(개발자용) — 상태에만 남기고 **사람이 읽는 문구에는 절대 안 넣는다.** */
      error: string;
      /** HTTP 상태코드(네트워크 실패는 0) · 라우트가 준 코드 — 사람 말 사유의 근거. */
      status?: number;
      code?: string | null;
    };

/** 렌더 안전벨트가 클립에 얹는 상태. 실행 로그가 아니라 **엔티티**에 산다(아래 주석 참조). */
export interface AutoRenderState {
  attempts: number;
  /** 첫 실패 시각(ms) — 정체 판정의 기준점. 재시도해도 안 밀린다. */
  firstAt: number;
  /** 마지막 시각(ms) — 확정 후 "하루 한 번 재확인" 의 근거. */
  lastAt: number;
  /** 원문 오류(개발자용). **로그 문구로 새면 안 된다** — 운영자가 읽을 수 없는 말이다. */
  lastError: string;
  /** 사람 말 사유를 만드는 근거. 옛 행에는 없어서 optional 이다. */
  lastStatus?: number;
  lastCode?: string | null;
  /** 확정 실패 — 더는 "곧 게시됩니다" 라고 말하지 않는다. */
  failed: boolean;
}

/**
 * `/api/clips/:id/export` 의 실패 표면을 성격으로 나눈다.
 *
 * ⚠️ `reframe_not_ready` 는 실패가 아니라 **순서를 기다리는 상태**다 — AI 리프레임에 이미
 * 30분 정체 강등 벨트가 있는데 시간축이 같은 30분이라, 대기를 실패로 세면 경계에서 렌더가
 * 먼저 확정 실패로 굳어 멀쩡한 클립이 죽는다.
 *
 * ⚠️ 하지만 `reframe_plan_invalid` 는 **대기가 아니다.** 리프레임 벨트의 조건은
 * `rf.status !== "ready"` 인데 plan_invalid 는 **status=ready 인 채로 플랜만 무효**라
 * (index.ts /export: 해시 불일치·정규화 실패) 벨트를 그대로 통과한다. waiting 으로 두면
 * 카운터도 시계도 안 움직여 → 매 순방 409 → autoRender 상태는 생기지도 않고 → 로그엔
 * "완료되면 자동으로 게시됩니다" 한 줄만 평생 남는 **영구 침묵**이 된다. retryable 로 세어
 * 3회/30분 벨트가 잡게 한다(RENDER_MAX_ATTEMPTS).
 */
export function classifyRenderFailure(status: number, code?: string | null): RenderFailureKind {
  if (code === "reframe_not_ready") return "waiting";
  // 404(클립 없음)·400(구간 없음)은 다시 눌러도 같은 답이 온다 — 시간이 못 고친다.
  if (status === 404 || status === 400) return "permanent";
  // 409(원본 없음·ffmpeg 없음·플랜 무효)·500(렌더 실패)·네트워크는 복구될 수 있다. 다만
  // 무한히 낙관하지는 않는다 — 횟수·시간 상한이 아래에서 확정으로 바꾼다.
  return "retryable";
}

/**
 * 렌더 실패를 **운영자가 읽을 수 있는 한 줄**로 옮긴다.
 *
 * 예전엔 확정 문구에 `state.lastError` 를 그대로 붙여서, 방송사 운영자 화면에
 * "(마지막 오류: 409 no master video or ffmpeg unavailable to render)" 가 떴다.
 * 원문은 상태(autoRender.lastError)에만 남기고 **문구에는 이 매핑만 쓴다.**
 */
export function renderFailureReason(status?: number | null, code?: string | null): string {
  if (code === "reframe_not_ready" || code === "reframe_plan_invalid") {
    return "AI 리프레임 결과가 아직 준비되지 않았습니다";
  }
  const s = Number(status ?? 0);
  if (s === 404) return "클립을 찾을 수 없습니다";
  if (s === 400) return "클립의 구간 정보가 없습니다";
  if (s === 409) return "원본 영상을 찾을 수 없거나 렌더 준비가 안 됐습니다";
  if (s === 401 || s === 403) return "렌더 요청이 거절됐습니다";
  if (s >= 500) return "렌더에 실패했습니다";
  if (s <= 0) return "렌더 요청에 응답이 없었습니다";
  return "렌더를 시작하지 못했습니다";
}

/**
 * **그래서 무엇을 하면 되는가** — 사유마다 다르다.
 *
 * 예전엔 확정 문구의 조치가 사유와 무관하게 하나였다: "원본 영상이 남아 있는지 확인하고,
 * 편집기에서 확정(렌더)을 다시 하면 다음 확인 때 이어서 게시합니다." 그런데 AI 리프레임
 * 플랜이 무효면(`reframe_plan_invalid`) **편집기 확정(렌더)도 같은 라우트라 똑같이 막힌다**
 * (index.ts `/api/clips/:id/export`: ai_multi 인데 플랜 해시가 안 맞으면 409). 안내대로 해도
 * 같은 실패가 반복된다 — 못 지킬 안내는 안내가 아니라 시간 낭비다.
 *
 * 조치가 실제로 통하는지는 라우트로 확인했다:
 *  - 리프레임 재분석 · 리프레임 끄기 → `POST /api/clips/:id/reframe` (`mode:"ai_multi"`+retry
 *    는 재큐잉, `mode:"basic"` 은 기본 모드로 되돌린다). 기본 모드가 되면 /export 의
 *    ai_multi 분기를 아예 안 타므로 그 409 가 사라진다. 편집기 AI 패널의 두 버튼이 이 경로다.
 *  - 원본 없음(409) → 원본이 돌아오면 하루 한 번 재확인(shouldRequestAutoRender)이 집어 간다.
 *  - 나머지(변환 실패·무응답) → 편집기에서 확정(렌더)을 다시 하면 그 클립은 렌더된 상태가 되고,
 *    다음 순방이 게시로 잇는다.
 */
export function renderFailureAction(status?: number | null, code?: string | null): string {
  if (code === "reframe_not_ready" || code === "reframe_plan_invalid") {
    // "AI" 를 쓰지 않는다 — 운영자 문구에 로마자를 섞지 않기로 한 규칙(테스트가 강제).
    return "편집기 AI 리프레임 패널에서 다시 분석하거나 기본 모드를 선택한 뒤 확정(렌더)해 주세요.";
  }
  const s = Number(status ?? 0);
  if (s === 404) return "이미 지운 클립이면 그대로 두고, 필요하면 회차 화면에서 다시 채택해 주세요.";
  if (s === 400) return "편집기에서 클립 구간을 다시 지정한 뒤 내보내 주세요.";
  if (s === 409) return "원본 영상이 남아 있는지 확인해 주세요 — 원본을 되살리면 다음 날 확인에서 다시 시도합니다.";
  if (s === 401 || s === 403) return "잠시 뒤에도 같으면 담당자에게 문의해 주세요.";
  return "편집기에서 확정(렌더)을 다시 해 주세요 — 되면 다음 확인 때 이어서 게시합니다.";
}

/** KST 날짜(YYYY-MM-DD). auto-topup 의 kstDateStamp 와 같은 계산이지만, 그 파일은 db·portone 을 끌어와 순수 모듈에서 import 할 수 없다. */
function kstDay(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 이번 렌더 결과를 반영한 다음 상태. null 이면 상태를 지운다(정상). */
export function nextAutoRenderState(
  prev: AutoRenderState | null | undefined,
  outcome: RenderOutcome,
  now: number,
): AutoRenderState | null {
  if (outcome.ok) return null;
  // 대기는 시도가 아니다 — 카운터도 시계도 건드리지 않는다(리프레임 벨트와 이중 처벌 금지).
  if (outcome.kind === "waiting") return prev ?? null;
  const attempts = (prev?.attempts ?? 0) + 1;
  const firstAt = prev?.firstAt ?? now;
  return {
    attempts,
    firstAt,
    lastAt: now,
    lastError: String(outcome.error).slice(0, 200),
    lastStatus: Number(outcome.status ?? 0),
    lastCode: outcome.code ?? null,
    failed: outcome.kind === "permanent"
      || attempts >= RENDER_MAX_ATTEMPTS
      || now - firstAt >= RENDER_STUCK_MS,
  };
}

/**
 * 지금 렌더를 (다시) 요청해도 되는가.
 *
 * 확정 실패 뒤에도 **KST 날짜가 바뀌면 하루 한 번**은 다시 본다 — 원본을 복구하면 사람이
 * 편집기에서 다시 내보내지 않아도 되살아난다. 재확인을 빼면 그 클립은 영원히 자동 경로
 * 밖에 남고, 주기를 짧게 하면 실패 폭주로 되돌아간다.
 */
export function shouldRequestAutoRender(
  state: AutoRenderState | null | undefined,
  now: number,
): boolean {
  if (!state?.failed) return true;
  return kstDay(now) !== kstDay(state.lastAt);
}

/**
 * 확정 순간에 한 번 남기는 사건 기록 — 무엇이 몇 번, 왜 실패했는지, **무엇을 하면 되는지.**
 *
 * 사유·조치 모두 **사람 말로만** 적는다(renderFailureReason·renderFailureAction).
 * 원문(`lastError`)은 클립 상태에 남아 있으니 개발자는 거기서 본다 — 실행 로그는 방송사
 * 운영자가 읽는 자리다. 조치는 사유마다 다르다: 하나로 고정하면 그 조치가 안 통하는 사유에서
 * 사용자가 시킨 대로 하고도 같은 실패를 다시 본다.
 */
export function autoRenderFailedNote(state: AutoRenderState): string {
  return `렌더가 ${state.attempts}회 실패해 자동 게시를 멈춥니다`
    + ` (${renderFailureReason(state.lastStatus, state.lastCode)}).`
    + ` ${renderFailureAction(state.lastStatus, state.lastCode)}`;
}

/**
 * 확정 실패한 클립을 순방이 건너뛸 때의 문구.
 *
 * `autoRenderFailedNote` 와 달리 **변동값이 없다** — 이건 매 순방 마주치는 상태라 문구가
 * 곧 dedupe 키가 되어야 한다(클립당 한 줄). 사건은 위, 상태는 여기.
 */
export const AUTO_RENDER_STOPPED_NOTE =
  "렌더가 실패해 이 클립의 자동 게시를 멈췄습니다"
  + " — 편집기에서 확정(렌더)이 되는지 확인해 주세요. 되면 다음 확인 때 이어서 게시합니다.";

/** 실행 로그 결과 종류 (F6 실행 로그). */
export const RUN_RESULTS = ["published", "recorded", "media_created", "held", "failed", "skipped"] as const;
export type RunResult = (typeof RUN_RESULTS)[number];

export const RUN_RESULT_LABEL: Record<RunResult, string> = {
  published: "게시됨",
  recorded: "기록됨",
  media_created: "미디어 생성",
  held: "보류",
  failed: "실패",
  skipped: "건너뜀",
};

/** 규칙 삭제 안내 (F6 ⚑ — 이미 게시된 건은 내려가지 않는다). */
export const RULE_DELETED_NOTICE =
  "규칙을 지웠습니다. 이미 게시된 영상은 내려가지 않습니다 — 필요하면 채널에서 직접 내려야 합니다.";

export function isRuleMediaKind(v: unknown): v is RuleMediaKind {
  return typeof v === "string" && (RULE_MEDIA_KINDS as readonly string[]).includes(v);
}
export function isRuleCriterion(v: unknown): v is RuleCriterion {
  return typeof v === "string" && (RULE_CRITERIA as readonly string[]).includes(v);
}
export function isGatePolicy(v: unknown): v is GatePolicy {
  return typeof v === "string" && (GATE_POLICIES as readonly string[]).includes(v);
}
export function isRuleOrientation(v: unknown): v is RuleOrientation {
  return typeof v === "string" && (RULE_ORIENTATIONS as readonly string[]).includes(v);
}
export function isRuleReframe(v: unknown): v is RuleReframe {
  return typeof v === "string" && (RULE_REFRAMES as readonly string[]).includes(v);
}
export function isRuleThumbnailMode(v: unknown): v is RuleThumbnailMode {
  return typeof v === "string" && (RULE_THUMBNAIL_MODES as readonly string[]).includes(v);
}
