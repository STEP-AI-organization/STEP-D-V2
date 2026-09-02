/**
 * 자동 배포 계획 엔진 (FLOWS F6). 순수 모듈.
 *
 * **계획 하나 = 프로그램 ↔ 채널 연결 하나.** 계획만 만들어 두면 이후는 사람 손 없이 돈다.
 *
 * 이 파일이 지키는 불변식 둘 (FLOWS.md:142):
 *  1. **자동 배포는 게이트를 건너뛰지 않는다.** 보류된 건은 사람이 확정해야 다음 순방에
 *     다시 잡힌다 — 시간이 지났다고 저절로 풀리지 않는다.
 *  2. **계획이 없으면 파이프라인은 아무것도 하지 않는다.** "전체 자동 실행" 같은 기본
 *     동작이 없다. 이건 편의 기능이 아니라 안전장치다 — 기본 동작이 있으면 계획을
 *     하나도 안 만든 상태에서 뭔가가 나간다.
 */

export const RULE_MEDIA_KINDS = ["short", "clip", "both"] as const;
export type RuleMediaKind = (typeof RULE_MEDIA_KINDS)[number];

/**
 * 채택 기준 — **"점수 순 상위" 하나뿐이다** (2026-08-26 사용자: 점수 하한 축 제거).
 *
 * 예전엔 `score80`·`score85` 하한을 고를 수 있었는데, 쇼츠 score100 은 회차 내 백분위라
 * 42~72 대에 눌려 80 을 못 넘는 구조다(실측 20편) — 계획은 켜져 있는데 아무것도 안 나가는
 * 상태가 이 리포 최빈 실패모드였고, 화면에 뜨는 "점수 80 이상" 배지는 그 원인을 사용자에게
 * 설명해 주지도 못했다. 이제 뽑는 방식은 하나다: **점수 높은 순으로, 회차당 상한까지.**
 * 값은 DB 컬럼 호환을 위해 남긴다(레거시 행의 score80/score85 는 읽을 때 무시된다).
 */
export const RULE_CRITERIA = ["top3"] as const;
export type RuleCriterion = (typeof RULE_CRITERIA)[number];

/**
 * 게이트 정책 (F6 계획 항목).
 * - `approve_first`: 게시 전 사람 승인. 조건을 통과해도 사람 손을 한 번 거친다.
 * - `hold_on_issue`: **승인 없이 즉시 발행.** 조건만 통과하면 그대로 나간다.
 *
 * ⚠️ 이름이 실제 동작과 다르다. 원래는 "권리 이슈가 있으면 보류" 였는데 **권리 게이트가
 * 2026-08-31 에 제거돼**(사용자 결정: "실전에서 필요가 없음") 보류시킬 조건 자체가 없어졌다.
 * 값 이름은 DB 에 저장돼 있어 그대로 두지만, 화면·문구에서는 "승인 없이 배포" 라고만 쓴다.
 * 이 값을 보고 "무언가 걸러 준다" 고 기대하면 안 된다 — 아무것도 안 거른다.
 */
export const GATE_POLICIES = ["approve_first", "hold_on_issue"] as const;
export type GatePolicy = (typeof GATE_POLICIES)[number];

/**
 * 채택 형태 (2026-08-14) — **수동 채택 다이얼로그와 같은 값 체계**(8023f6a · store.tsx
 * adoptRecommendation opts). 자동 순방엔 다이얼로그에서 고를 사람이 없어 계획에 미리 담는다.
 * 값 체계가 갈라지면 화면·서버가 서로 다른 말을 하게 되므로 이름·값을 그대로 쓴다.
 */
export const RULE_ORIENTATIONS = ["portrait", "landscape"] as const;
export type RuleOrientation = (typeof RULE_ORIENTATIONS)[number];
export const RULE_REFRAMES = ["ai", "none"] as const;
export type RuleReframe = (typeof RULE_REFRAMES)[number];

/**
 * 세로 영상 배치 (2026-09-02) — 편집기 `aspect-presets` 의 **세로 프리셋 id 그대로**.
 *
 * ⚠️ 여기서 `aspect-presets.ts` 를 import 하지 않는다. 이 파일은 **import 0개짜리 순수
 *    모듈**이고 웹이 `@server-pure/pipeline/automation` 로 그대로 가져다 쓴다(위 파일 주석).
 *    한 줄만 들여와도 그 계약이 깨진다. 대신 값을 여기 적고 **automation-aspect.test.ts 가
 *    프리셋의 세로 부분집합과 대조**한다 — 프리셋이 늘면 테스트가 빨간불을 켠다.
 *
 * 가로(16:9)는 뺀다. 가로/세로는 이미 `orientation` 이 정하고 있어서, 여기서도 가로를
 * 받으면 두 필드가 서로 다른 말을 할 수 있다. 이 값은 **세로일 때 어떤 배치인가**만 말한다.
 */
export const RULE_ASPECTS = [
  "9:16-letterbox", "9:16-crop-full", "9:16-crop-main", "9:16-crop-sub",
] as const;
export type RuleAspect = (typeof RULE_ASPECTS)[number];
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
  /** DB 컬럼 호환용 잔여 필드 — 엔진은 읽지 않는다(2026-08-26 점수 하한 축 제거). */
  criterion?: RuleCriterion;
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
    /** 요소 표시 여부 — 미지정 = 표시(하위호환). 고객마다 로고·시간박스·제목을 뺄 수 있다. */
    title?: boolean;
    logo?: boolean;
    timebox?: boolean;
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
  slots?: RuleSlotInput[] | null;
  /** 채택 방향 — 수동 채택과 같은 값. 미지정 = 기존처럼 추천 kind 로 결정(하위호환). */
  orientation?: RuleOrientation | null;
  /** 'ai' = 세로형 채택 직후 AI 리프레임(clip.reframe) 큐잉. 세로형일 때만 의미. */
  reframe?: RuleReframe | null;
  /**
   * 세로 영상 배치. 미지정 = SHORTS_DEFAULT_ASPECT(레터박스) — **기존 계획의 결과물이
   * 바뀌지 않도록** 기본을 옮기지 않는다. 가로로 나가는 건에는 의미가 없다.
   */
  aspect?: RuleAspect | null;
  /** 썸네일 생성 방식. 미지정 = frame(안전한 쪽 · 인물 등록 없이도 나온다). */
  thumbnailMode?: RuleThumbnailMode | null;
}

/** 계획의 프로그램 목록 — 다중이 있으면 다중, 없으면 단수 폴백. */
export function rulePrograms(rule: AutomationRule): string[] {
  return rule.programIds?.length ? rule.programIds : [rule.programId];
}

/** 계획의 채널 목록 — 다중이 있으면 다중, 없으면 단수 폴백. */
export function ruleChannels(rule: AutomationRule): { platform: string; accountId: string }[] {
  return rule.channels?.length ? rule.channels : [{ platform: rule.platform, accountId: rule.accountId }];
}

export interface AutomationChannelConflict {
  platform: string;
  accountId: string;
  ruleId: string;
  programId: string;
}

/**
 * 한 채널은 자동배포 하나만 소유한다.
 *
 * 화면에서 선택을 막더라도 외부 API(AENA 포함)가 직접 저장할 수 있으므로 서버 저장 직전에
 * 같은 판정을 다시 쓴다. 계획을 수정할 때는 자기 id 를 빼야 기존 채널을 그대로 유지할 수 있다.
 */
export function findAutomationChannelConflicts(
  rules: Pick<AutomationRule, "id" | "programId" | "platform" | "accountId" | "channels">[],
  requested: { platform: string; accountId: string }[],
  ignoreRuleId?: string,
): AutomationChannelConflict[] {
  const requestedKeys = new Set(
    requested
      .filter((channel) => channel.platform && channel.accountId)
      .map((channel) => `${channel.platform}:${channel.accountId}`),
  );
  const conflicts: AutomationChannelConflict[] = [];
  for (const rule of rules) {
    if (rule.id === ignoreRuleId) continue;
    const channels = rule.channels?.length
      ? rule.channels
      : [{ platform: rule.platform, accountId: rule.accountId }];
    for (const channel of channels) {
      if (!requestedKeys.has(`${channel.platform}:${channel.accountId}`)) continue;
      conflicts.push({
        platform: channel.platform,
        accountId: channel.accountId,
        ruleId: rule.id,
        programId: rule.programId,
      });
    }
  }
  return conflicts;
}

/**
 * 계획의 활동 시간창(KST 시각) — 기본 9~22.
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

/** 오늘이 이 계획의 발행 요일인가. 요일 미지정이면 언제나 참(기존 동작). */
export function isPublishDay(rule: Pick<AutomationRule, "weekdays">, now = new Date()): boolean {
  const days = ruleWeekdays(rule);
  return days === null || days.includes(kstWeekday(now));
}

/**
 * 슬롯 한 칸 — 시각 + **그 시각에 나가는 개수** (2026-08-25 사용자: "시간대 하나 = 하루
 * 1개" 의존성 파괴 — 7시 2개·9시 3개처럼). 구형 저장분은 "HH:MM" 문자열(=1개)이다.
 */
export interface RuleSlot { time: string; count: number }
/** 저장·수신 허용 형태 — 구형 문자열과 신형 객체 혼용. ruleSlots() 가 한 형태로 접는다. */
export type RuleSlotInput = string | { time?: unknown; count?: unknown };

/** 슬롯당 개수 상한 — 오타(300)가 채널을 도배하지 않게. 필요해지면 올린다. */
export const SLOT_COUNT_MAX = 20;

const SLOT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 슬롯 정규화 — 유효한 "HH:MM" 만 남기고 시각순 정렬. 같은 시각 중복은 **뒤 항목이 이긴다**
 * (구형 중복 문자열도 자연히 한 칸 count 1 로 접힘 = 종전 동작). count 는 1..SLOT_COUNT_MAX.
 */
export function ruleSlots(rule: Pick<AutomationRule, "slots">): RuleSlot[] {
  const raw = Array.isArray(rule.slots) ? rule.slots : [];
  const byTime = new Map<string, number>();
  for (const entry of raw) {
    const time = String((typeof entry === "object" && entry !== null ? entry.time : entry) ?? "").trim();
    if (!SLOT_TIME_RE.test(time)) continue;
    const rawCount = typeof entry === "object" && entry !== null ? Number(entry.count) : 1;
    const count = Number.isFinite(rawCount) && rawCount >= 1
      ? Math.min(SLOT_COUNT_MAX, Math.floor(rawCount)) : 1;
    byTime.set(time, count);
  }
  return [...byTime.entries()]
    .map(([time, count]) => ({ time, count }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** 슬롯 표기 한 조각 — "07:00×2" (1개면 시각만). 서버 로그·웹 표시가 같은 모양을 쓴다. */
export function slotLabel(s: RuleSlot): string {
  return s.count > 1 ? `${s.time}×${s.count}` : s.time;
}

/** KST 벽시계 분(0~1439). 슬롯 비교의 기준축. */
export function kstMinutes(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** 오늘 지금까지 지난 슬롯의 개수 합 — 그만큼이 오늘 이 시각까지 허용되는 누적 발행 수다. */
export function slotsElapsed(slots: RuleSlot[], now = new Date()): number {
  const cur = kstMinutes(now);
  return slots.reduce((sum, s) => {
    const [h, m] = s.time.split(":").map(Number);
    return h * 60 + m <= cur ? sum + s.count : sum;
  }, 0);
}

/** Queue explicit publish slots two hours ahead; YouTube publishes at target time. */
export const AUTOMATION_QUEUE_LEAD_MIN = 120;

/**
 * 순방 한 틱의 게시 상한 — 엔진 정지 후 복구 시 놓친 슬롯 몫이 한 번에 몰리는
 * 연속 게시 폭탄을 페이스로 바꾼다(몫은 소멸하지 않고 다음 틱이 이어간다).
 * 정상 운영(2시간 선행 큐잉)에서는 이 상한이 보일 일이 없다.
 */
export const AUTOMATION_MAX_PUBLISH_PER_TICK = 3;

/**
 * 순방 틱 간격(분) — Cloud Scheduler 가 15분마다 워커를 깨운다(stepd-worker-youtube-tick).
 * 아래 페이스 산식의 근거다 — 스케줄을 바꾸면 이 값도 같이 봐야 한다.
 */
export const AUTOMATION_TICK_MIN = 15;

/**
 * 이 계획의 **틱당 게시 상한** — 하루 몫에 비례해 키운다 (2026-08-26).
 *
 * 고정 3 은 하루 3건 계획을 전제한 값이었다. 하루 20건 계획에서는 20÷3 = 7틱 =
 * **105분**이 필요한데 큐잉 리드가 120분뿐이라, 순방이 한 번만 밀려도 슬롯 시각을
 * 넘긴다(넘기면 예약이 아니라 즉시 게시라 "몇 시에 20개" 가 안 지켜진다).
 *
 * 그래서 **리드 시간의 절반 안에 하루 몫을 끝낼 수 있는 페이스**를 하한으로 준다:
 * 20건이면 4틱(60분) → 5건/틱. 상한(SLOT_COUNT_MAX=20)이 있어 무한정 커지지 않고,
 * 폭탄 방지라는 원래 목적(엔진 복구 직후 몰림)은 그대로다 — 하루 몫 자체가 상한이라
 * 하루치를 넘겨 쏟아지지는 않는다.
 */
export function maxPublishPerTick(
  rule: Pick<AutomationRule, "slots" | "dailyQuota">,
  leadMin = AUTOMATION_QUEUE_LEAD_MIN,
  tickMin = AUTOMATION_TICK_MIN,
): number {
  const perDay = perDayCount(rule);
  const ticks = Math.max(1, Math.floor(leadMin / 2 / tickMin));
  return Math.max(AUTOMATION_MAX_PUBLISH_PER_TICK, Math.ceil(perDay / ticks));
}

/**
 * 순방 한 틱이 **렌더 선행 준비**에 쓰는 최대 건수 (2026-08-26).
 *
 * 채택된 클립은 발행 시각 전에 이미 렌더돼 있어야 한다("렌더가 안 돼서 못 나갔다" 는
 * 사용자가 명시적으로 거부한 실패 모드). 그래서 게시 할당량과 무관하게 미렌더 클립을
 * 미리 채우는데, 렌더는 건당 50~90초라 무제한이면 틱 하나가 렌더로만 40분을 쓴다.
 *
 * 8건 × 90초 = 12분 — 틱 간격(15분) 안에 들어오고, drain 상한(45분)에는 한참 못 미친다.
 * 하루 20건 계획이라도 채택은 회차 단위로 흩어지므로 한 틱에 8건이면 충분히 앞선다.
 */
export const AUTOMATION_MAX_RENDERS_PER_TICK = 8;

/**
 * 렌더를 **큐로 넘길 것인가**(= 사무실 PC 가 당겨가게) — 기본 OFF.
 *
 * 켜면 순방이 `/export` 를 직접 부르는 대신 `clip.render` 잡을 넣는다. 렌더는 이 리포에서
 * CPU 를 통째로 쓰는 유일한 일이라(건당 50~90초), 노는 사무실 PC(8코어)로 옮기면 위 상한이
 * 풀리고 클라우드 렌더 비용도 빠진다.
 *
 * ⚠️ 실패 방향을 고정한다: 오타·빈값은 전부 OFF = **종전대로 클라우드가 굽는다.**
 * 잘못된 env 의 결과가 "렌더가 안 나감" 이면 안 된다 — 그건 곧 배포가 멈추는 것이다.
 */
export function renderViaQueue(): boolean {
  const v = String(process.env.RENDER_VIA_QUEUE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * 큐에 넘긴 렌더가 이만큼 방치되면 **클라우드가 대신 굽는다**(기본 10분).
 *
 * 사무실 PC 는 꺼질 수 있고, 꺼진 걸 우리가 즉시 알 방법은 없다. 그 사이 고객 배포가
 * 멈추면 안 되므로(ENA 는 계약 물량이다) 정체를 감지해 스스로 되돌아온다.
 * 렌더 한 건이 90초라, 10분은 "PC 가 도는데 밀린 것" 과 "PC 가 없는 것" 을 가르는 선이다.
 */
export function renderQueueStallMs(): number {
  const n = Number(process.env.RENDER_QUEUE_STALL_MS);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
}

/**
 * 슬롯을 "놓쳤다"고 보는 유예(분) — 순방 틱 간격(10~15분) + 여유. 이 안이면 조금
 * 늦게라도 게시하고, 넘겼으면 그 몫은 **오늘은 포기**한다(내일 그 슬롯에 다시).
 *
 * 예전엔 지나간 슬롯 몫이 하루 종일 살아 있어, 저녁에 계획을 켜면 아침 슬롯 몫이
 * 그 자리에서 전부 나갔다 — 2026-08-25 ENA 실전: 09:00×3 계획을 20시에 켜자
 * 3건이 밤 8~9시에 즉시 게시("아침 9시로 정했는데 밤 9시에 나감").
 */
export const SLOT_MISS_GRACE_MIN = 60;

/**
 * 오늘 유예를 넘겨 놓친 슬롯 몫(= 오늘은 포기할 수). 이미 게시된 수(publishedToday)는
 * **옛 슬롯부터 배정된 것으로 보고** 차감한다 — 제시간에 나간 아침 몫을 '놓침'으로
 * 오인해 저녁 슬롯 몫까지 깎으면 안 된다.
 *
 * ⚠️ **오늘 한 건이라도 나간 계획의 몫은 버리지 않는다** (2026-08-26). 렌더·순방 페이스
 * 때문에 슬롯 시각을 넘겨 배달 중인 계획에서 유예(60분)가 남은 몫을 소멸시키면,
 * "15시에 20개" 로 설정한 날 8개만 나가고 12개가 소리 없이 사라진다 — 사용자가 정한
 * 개수가 안 지켜지는 게 시각이 밀리는 것보다 더 큰 사고다. 포기는 **오늘 0건인 계획**
 * 에만 적용한다 — 저녁에 켠 계획이 아침 몫을 그 자리에서 쏟는 사고(이 함수가 태어난
 * 이유 · 09:00×3 을 20시에 켜자 밤에 3건)는 그 조건만으로 그대로 막힌다.
 */
export function staleMissedSlots(
  slots: RuleSlot[], publishedToday: number, now = new Date(), graceMin = SLOT_MISS_GRACE_MIN,
): number {
  if (publishedToday > 0) return 0;
  const cur = kstMinutes(now);
  return slots.reduce((sum, s) => {
    const [h, m] = s.time.split(":").map(Number);
    return h * 60 + m < cur - graceMin ? sum + s.count : sum;
  }, 0);
}

export function slotsReadyForQueue(
  slots: RuleSlot[], now = new Date(), leadMin = AUTOMATION_QUEUE_LEAD_MIN,
): number {
  const cutoff = kstMinutes(now) + leadMin;
  return slots.reduce((sum, s) => {
    const [h, m] = s.time.split(":").map(Number);
    return h * 60 + m <= cutoff ? sum + s.count : sum;
  }, 0);
}

/**
 * Return today's KST slot as an absolute Date for YouTube publishAt.
 * index 는 **발행 순번**이다(슬롯 칸 번호가 아니라) — 7시×2·9시×3 이면 순번 0·1 이 7시,
 * 2~4 가 9시. 같은 시각 여러 건은 같은 publishAt 으로 나간다(유튜브 예약은 동시각 허용).
 */
export function scheduledSlotAt(slots: RuleSlot[], index: number, now = new Date()): Date | null {
  let cum = 0;
  let slot: RuleSlot | undefined;
  for (const s of slots) {
    cum += s.count;
    if (index < cum) { slot = s; break; }
  }
  if (!slot) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const date = ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)?.value).join("-");
  const at = new Date(`${date}T${slot.time}:00+09:00`);
  return Number.isFinite(at.getTime()) ? at : null;
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

/** 하루 발행 수 — 슬롯이 있으면 슬롯 개수의 **합**이 곧 하루 발행 수다. */
export function perDayCount(rule: Pick<AutomationRule, "slots" | "dailyQuota">): number {
  const slots = ruleSlots(rule);
  if (slots.length) return slots.reduce((sum, s) => sum + s.count, 0);
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
  const hour = Math.floor(kstMinutes(now) / 60);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * 실업로드까지 가는 채널인가 — 계획 상태·안내 문구의 기준.
 *
 * **`publish-guard.ts` 의 `channelPublishMode` 와 같은 목록이어야 한다.** 예전엔 여기만
 * "youtube 아니면 기록만" 이었는데, 네이버는 실제로 브라우저 자동화로 **올라간다**.
 * 그래서 "배포 기록만 남습니다" 라고 안내한 채널에 영상이 나가는 안전 문구 역전이 됐다.
 * 게이트가 꺼져 있으면 실제로는 기록만 되지만, 그건 켜고 끄는 축이라 상태가 아니라
 * 배너로 알린다(자동화 화면 gates).
 */
export const UPLOAD_PLATFORMS = new Set([
  "youtube", "navertv", "naverclip", "instagram", "facebook", "tiktok",
]);

/**
 * 계획 생성 시 상태 분기 (F6).
 * 실업로드 채널이면 running, 상태 기록만 하는 채널(Meta·SMR 스텁 등)은 `기록만`.
 */
export function initialRuleState(platform: string, enabled = true): RuleState {
  if (!enabled) return "paused";
  return UPLOAD_PLATFORMS.has(platform) ? "running" : "record_only";
}

/** 계획 생성 토스트 문구 (F6 ⚑ — 기록만 하는 채널은 반드시 알린다). */
export function ruleCreatedNotice(platform: string): string {
  return UPLOAD_PLATFORMS.has(platform)
    ? "계획이 실행 중입니다 — 다음 순방부터 적용됩니다."
    : "이 채널은 배포 기록만 남습니다 — 실제 게시는 담당자가 해당 앱에서 직접 해야 합니다.";
}

// ── 03 미디어 생성: 어떤 추천을 채택할 것인가 ───────────────────────────────────

export interface Candidate {
  id: string;
  kind: string;
  score100?: number | null;
  status?: string | null;
}

/** 회차당 채택 상한의 하한선 — **회차(에피소드)당** 총 3건이지, 순방당 3건이 아니다. */
export const TOP3_CAP = 3;

/**
 * 이 계획이 **한 회차에서** 채택할 수 있는 최대 건수.
 *
 * 하루 발행 수(슬롯 합·할당량)를 따라간다 — 예전엔 3 고정이라, 하루 6개를 걸어 둔 계획이
 * 회차 하나만 있는 날엔 3건에서 멈췄다(사용자가 정한 개수가 조용히 안 지켜지는 형태의 사고).
 * 하한 3 은 종전 동작 보존용이다: 하루 1~3개짜리 계획은 예전과 똑같이 회차당 3건까지 본다.
 *
 * 상한이 아예 없으면 순방마다 새 후보가 계속 뽑혀 추천 전량이 클립화된다(렌더는 실제 원가다).
 */
export function episodeAdoptCap(rule: Pick<AutomationRule, "slots" | "dailyQuota">): number {
  return Math.max(TOP3_CAP, perDayCount(rule));
}

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
 * 이 추천이 계획의 미디어 종류에 맞는가.
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
 * 계획 조건을 통과한 추천만 고른다 (F6 03단계).
 * 이미 판단된 것(채택·거절)은 다시 잡지 않는다 — 사람이 거절한 걸 자동이 되살리면 안 된다.
 *
 * 규칙은 하나다: **종류가 맞는 후보를 점수 높은 순으로, 회차당 상한까지.**
 * (2026-08-26 점수 하한 축 제거 — 하한은 쇼츠 점수 분포상 전량을 막아 세우는 함정이었다.)
 *
 * `adoptedCount` = 이 계획이 **같은 회차에서 이미 채택한 수**(클립의 automationRuleId ·
 * episodeId 로 센다). 채택하면 후보가 pending 풀에서 빠지므로, 이걸 안 빼면 순방마다
 * "새 상위 N건"이 또 뽑혀 상한이 없는 것과 같다(수 시간이면 추천 전량이 클립화).
 */
export function selectCandidates(
  rule: AutomationRule,
  candidates: Candidate[],
  adoptedCount = 0,
): Candidate[] {
  const undecided = candidates.filter((c) => (c.status ?? "pending") === "pending");
  const byKind = undecided.filter((c) => matchesMediaKind(rule, c));

  // 회차당 잔여 상한. 이미 다 채웠으면 아무것도 뽑지 않는다.
  const remaining = Math.max(0, episodeAdoptCap(rule) - Math.max(0, Math.trunc(adoptedCount)));
  if (remaining === 0) return [];
  // 점수가 없는 후보는 상위 N 에서 뺀다 — 0점으로 치면 아무거나 올라온다.
  return byKind
    .filter((c) => typeof c.score100 === "number")
    .sort((a, b) => (b.score100 ?? 0) - (a.score100 ?? 0))
    .slice(0, remaining);
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
  /** 사람이 승인했는가 (approve_first 정책에서만 본다). */
  approved: boolean;
  /** 이미 보류 처리됐고 아직 사람이 확정하지 않았는가. */
  heldAwaitingHuman: boolean;
}): StepDecision {
  const { rule } = input;

  if (!rule.enabled) return { action: "skip", reason: "계획이 멈춰 있습니다." };

  // ⚠️ **권리 게이트 분기는 2026-08-31 에 제거됐다**(사용자 결정: "실전에서 필요가 없음").
  // 근거: `rights_issue` 0행 · `gate_audit` allowed 114 대 blocked 1(수동 테스트).
  // 남은 두 관문은 **사람의 결정**이지 자동 판정이 아니다 — 보류 확정과 approve_first.

  // 보류된 건은 **사람이 확정해야** 다시 잡힌다. 게이트가 열렸다고 저절로 나가지 않는다.
  if (input.heldAwaitingHuman) {
    return { action: "hold", reason: "보류 상태입니다 — 사람이 확정해야 다음 순방에 다시 잡힙니다.", needsHuman: true };
  }

  if (rule.gatePolicy === "approve_first" && !input.approved) {
    return { action: "hold", reason: "게시 전 사람 승인이 필요한 계획입니다.", needsHuman: true };
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

/**
 * 자동배포 완료 알림을 받을 담당자 이메일이 담긴 automation_setting 키 (워크스페이스당 하나).
 * 값이 비어 있으면 알림을 보내지 않는다 — 알림도 계획과 같은 원칙이다: 설정이 없으면
 * 아무것도 하지 않는다. 발송 지점은 워커의 실업로드 성공 자리(publish-notify.ts) 하나뿐이다.
 *
 * **값의 꼴이 두 가지다**(2026-09-02 여러 명 지원). 아래 parseNotifyEmails 로만 읽을 것:
 *   - 신규: JSON 배열 `["a@x.com","b@y.com"]` (결제 알림 billing.notifyEmails 와 같은 방식)
 *   - 구  : 단일 문자열 `a@x.com` — **이미 저장된 워크스페이스가 이 꼴이다.** 여기서
 *           배열만 읽게 만들면 지금 설정된 담당자가 조용히 빠지고 리포트가 아무에게도 안 간다.
 */
export const NOTIFY_EMAIL_KEY = "automation.notifyEmail";

/** 수신자 상한. 담당자 목록이지 메일링 리스트가 아니다 — 배포 리포트를 대량 발송으로 쓰지 않는다. */
export const NOTIFY_EMAIL_MAX = 10;

/** 담당자 이메일 1개의 형식 판정 — 저장 라우트와 발송 지점이 **같은 잣대**를 써야 한다. */
export function isNotifyEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
}

/**
 * 저장값 → 수신자 목록. 위 두 꼴을 모두 읽고, 형식이 아닌 항목은 버린다.
 *
 * 쉼표·세미콜론 구분도 받는다 — 사람이 입력창에 그렇게 넣는 게 자연스럽고, 예전 검증이
 * 그걸 400 으로 막고 있었다. 중복은 **대소문자 무시**로 제거한다(같은 사람에게 두 통 안 감).
 * 순수 함수다 — 이 파일은 import 0개 계약을 지킨다(웹이 @server-pure 로 그대로 쓴다).
 */
export function parseNotifyEmails(raw: string | null | undefined): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  let list: unknown[];
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];   // 깨진 JSON — 알림을 끄는 게 아니라 '수신자 없음' 으로 떨어뜨린다
    }
  } else {
    list = s.split(/[,;]/);
  }
  const out: string[] = [];
  for (const raw1 of list) {
    const t = String(raw1 ?? "").trim();
    if (!isNotifyEmail(t)) continue;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    out.push(t);
    if (out.length >= NOTIFY_EMAIL_MAX) break;
  }
  return out;
}

/** 목록 → 저장값. 빈 목록은 빈 문자열(행 삭제 대신 — DELETE 경합 회피, 종전과 같다). */
export function serializeNotifyEmails(emails: string[]): string {
  return emails.length ? JSON.stringify(emails) : "";
}

export interface CycleInput {
  /** 전역 일시정지 상태. */
  paused: boolean;
  rules: AutomationRule[];
}

export interface CyclePlan {
  /** 이번 순방에서 평가할 계획. */
  rules: AutomationRule[];
  /** 아무것도 안 하는 이유 (있으면 로그에 남긴다). */
  idleReason: string;
}

/**
 * 이번 순방에 무엇을 할지.
 *
 * **계획이 없으면 아무것도 하지 않는다** (F6 Invariant). 빈 배열을 "전체 대상"으로
 * 해석하지 않는다 — 그 실수 한 번이면 손대지 않은 프로그램들이 배포된다.
 *
 * 일시정지는 **새 회차를 잡지 않는 것**이지 진행 중인 걸 죽이는 게 아니다.
 * 이미 큐에 들어간 건은 그대로 나간다(F6 전역 토글).
 */
export function planCycle(input: CycleInput): CyclePlan {
  if (input.paused) return { rules: [], idleReason: "일시정지 상태 — 새 회차를 잡지 않습니다." };
  if (input.rules.length === 0) {
    return { rules: [], idleReason: "계획이 없습니다 — 자동 배포는 계획이 있어야만 동작합니다." };
  }
  const active = input.rules.filter((r) => r.enabled);
  if (active.length === 0) return { rules: [], idleReason: "실행 중인 계획이 없습니다." };
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
 * 계획 하나가 이번 순방에 아무 일도 안 한 사유. 하나만 고른다 —
 * 이유를 여러 개 늘어놓으면 어디부터 손대야 할지 모른다(channel-rules 의 eligibility 와 같은 원칙).
 *
 * 게시 단계 사유(render_*·gate_off·quota_done…)가 여기 함께 사는 이유: 그 사유들은 실행
 * 로그에 (클립,채널)당 한 줄로 눌러 두는데, 눌린 뒤에는 **그 계획이 왜 멈춰 있는지 아무도
 * 말하지 않는다.** 계획 단위 하루 한 줄로 이어 주는 자리가 여기다.
 */
export const RULE_IDLE_CODES = [
  "off_hours", "off_day",
  "no_episode", "analysis_blocked", "analysis_failed", "analyzing",
  "render_stopped", "gate_off", "publish_failed", "held_waiting", "vague_account",
  "channel_rule", "quota_done",
  "top3_cap", "score_blocked", "kind_mismatch", "overlap", "too_long",
  "render_waiting", "meta_waiting",
  "all_sent", "no_pending",
] as const;
export type RuleIdleCode = (typeof RULE_IDLE_CODES)[number];

/**
 * **기다리면 풀리는** 유휴 사유 — 이 셋은 "곧 더 나올 수 있다"는 뜻이다(분석 중·렌더 대기·
 * 메타 대기). 나머지 사유(후보 없음·종류 불일치·겹침·상한·길이 초과·점수 없음 등)는
 * 오늘 안에는 저절로 안 풀린다 — 새 회차를 올리거나 설정을 바꿔야 한다.
 *
 * 자동배포 리포트가 이 구분을 쓴다: 마지막 슬롯이 지났는데 사유가 전부 '안 풀리는' 쪽이면
 * 마감(+90분)을 기다리지 않고 그때까지 몫으로 보낸다(사용자 2026-08-27 "왜 4시 30분이지").
 */
export const WAITING_IDLE_CODES: ReadonlySet<RuleIdleCode> = new Set<RuleIdleCode>([
  "analyzing", "render_waiting", "meta_waiting",
]);

/** 이 사유가 "오늘은 더 나올 게 없다"인가 — 기다림형이 아니면 참. */
export function idleMeansNoMoreToday(code: RuleIdleCode): boolean {
  return !WAITING_IDLE_CODES.has(code);
}

/** 계획 하나를 평가하며 모은 관측치 — 순방(automation-cycle)이 채운다. */
export interface RuleIdleObservation {
  /** 지금이 활동 시간창 밖인가 — 참이면 계획 평가 자체를 건너뛴 것이라 나머지는 0이다. */
  outOfWindow: boolean;
  /** 활동 시간창(KST 시각) — 문구에 싣는다. 계획 설정이라 하루 안에 저절로 안 변한다. */
  activeStart: number;
  activeEnd: number;
  /** 오늘이 발행 요일이 아닌가 — 참이면 시간창과 마찬가지로 계획 평가를 통째로 건너뛴 것이다. */
  offDay?: boolean;
  /** 설정된 발행 요일(ISO). 문구에 싣는다 — 계획 설정이라 하루 안에 안 바뀐다. */
  weekdays?: number[] | null;
  /** 이 계획의 프로그램에 속한 회차 수. */
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
  /** 그중 계획의 미디어 종류와 맞는 수. */
  kindMatched: number;
  /** 종류는 맞지만 기존 클립과 구간이 겹쳐 제외된 수. */
  overlapped: number;
  /**
   * 종류·겹침을 통과했지만 **세로 숏폼 길이 상한**을 넘어 제외된 수 (2026-08-25).
   *
   * 조용히 빼면 안 된다 — 사용자가 보기엔 "점수 좋은 추천이 있는데 아무것도 안 나간다" 이고,
   * 기준을 낮춰 봐야 그대로 0건이다. 풀리는 조치가 다르다(회차 재분석 · 방향을 가로형으로).
   */
  tooLong?: number;
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
  /** 이 계획의 클립이 하나 이상 있고, 전부 연결된 채널 전부로 나갔는가. */
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
  mediaKind: RuleMediaKind;
}

/**
 * 자동화 화면(CRIT_LABEL·KIND_LABEL)과 **같은 어휘**. 로그와 화면이 다른 말을 하면 안 된다.
 *
 * ⚠️ 미디어 종류는 화면이 "숏폼" 이라고 부른다(automation/page.tsx KIND_LABEL). 여기만 "쇼츠"
 * 였던 적이 있는데, 같은 설정을 두 이름으로 부르면 사용자는 로그의 사유가 자기가 고른 설정을
 * 가리키는지조차 모른다. 화면 표기를 정본으로 삼는다.
 */
const MEDIA_KIND_LABEL: Record<RuleMediaKind, string> = {
  short: "숏폼", clip: "클립", both: "숏폼+클립",
};

/**
 * 왜 이 계획에서 아무 일도 안 났는지 — 한 줄로 고른다. 없으면(=일을 했으면) null.
 *
 * **고르는 순서에 근거가 있다.** 순서가 흔들리면 같은 상황에서 로그가 매번 다른 말을 한다.
 *  ⓪ 활동 시간창 밖이면 평가 자체를 안 했다 — 다른 사유를 말할 근거가 없다.
 *  ① 채택했으면 사유가 없다 — 할 일을 했다.
 *  ② 상류가 통째로 비었으면 그것부터(회차 없음). 하류 사유는 존재할 수가 없다.
 *  ③ **분석이 끝난 회차가 하나도 없으면 하류 사유는 전부 공허하다.** 이 가드가 없으면
 *     "채택할 추천이 없습니다" 라는 **틀린 사유**가 나간다 — 진짜 원인은 분석 실패/미시작/진행중이다.
 *  ④ 그다음이 **게시 단계에서 사람 손이 필요한 것**(렌더 확정 실패 · 게이트 OFF · 승인 대기 …).
 *     이미 만든 클립이 못 나가고 있는데 "채택할 추천이 없습니다" 라고 말하면 정반대를 보게 된다.
 *  ⑤ 그다음이 **사람이 계획을 바꾸면 풀리는 것**(상한 → 기준 → 종류 → 겹침).
 *  ⑥ 시간이 저절로 풀어 주는 사유(렌더·메타 대기)를 사람 몫보다 뒤에 두는 게 이 순서의 근거다.
 *  ⑦ 마지막이 정상 정지(다 나감) → 기본값(추천 없음).
 *
 * ⚠️ detail 문구에 **변동 숫자를 넣지 않는다.** 이 문자열이 곧 dedupe 키라서(hasRunNote),
 * 카운트가 섞이면 순방마다 새 줄이 쌓여 실행 로그가 이 줄로 덮인다. 문구에 들어가는 숫자는
 * 계획 설정(기준 점수·활동 시간 같은)뿐이다 — 하루 안에 저절로 바뀌지 않는다.
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
      // ⚠️ 이 문구는 dedupe 키다 — 오늘 요일 같은 **변동 값을 넣지 않는다**(계획 설정만).
      detail: `오늘은 발행 요일(${formatWeekdays(o.weekdays)})이 아니라 아무것도 하지 않았습니다`
        + " — 다음 발행 요일에 자동으로 이어서 확인합니다.",
    };
  }

  if (o.adopted > 0) return null;

  if (o.episodes === 0) {
    return { code: "no_episode", detail: "이 계획의 프로그램에 회차가 없습니다 — 회차를 올리면 다음 확인 때 잡습니다." };
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
      // 이건 **확정 실패**다 — 다만 한 시간에 한 번 자동 재시도가 돈다(2026-08-26).
      detail: "렌더가 실패해 아직 게시하지 못한 클립이 있습니다"
        + " — 한 시간에 한 번 자동으로 다시 시도합니다. 편집기에서 확정(렌더)하면 바로 이어집니다.",
    };
  }

  if (o.gateOff) {
    return {
      code: "gate_off",
      detail: "실제 업로드가 꺼져 있어 이 계획의 채널로는 보내지 못했습니다"
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
      // 채널 화면은 연결만 관리한다. 판정 조건을 별도 설정처럼 노출하지 말고, 사용자가 실제로
      // 해결할 수 있는 편집기 조치만 안내한다.
      detail: "채널의 기본 길이·화면비 조건에 맞지 않아 게시하지 못한 클립이 있습니다"
        + " — 클립을 편집기에서 해당 채널 형식에 맞게 손봐 주세요.",
    };
  }

  if (o.quotaDone) {
    return {
      code: "quota_done",
      detail: "오늘 이 계획 채널의 게시 할당량을 다 썼습니다 — 내일 자정(KST)에 초기화되면 이어서 게시합니다.",
    };
  }

  // 상한은 **모든** 분석 완료 회차가 닿았을 때만 사유가 된다. 한 회차라도 다른 이유로
  // 멈춘 거면 상한 탓이 아니다 — 덜 정확해도 과잉 주장보다 낫다.
  if (o.cappedEpisodes > 0 && o.cappedEpisodes === o.analyzed) {
    return {
      code: "top3_cap",
      // 상한은 하루 발행 수를 따라간다(episodeAdoptCap) — 조치는 둘뿐이다: 새 회차를 올리거나,
      // 하루 발행 수를 늘리거나. "기준을 점수로 바꾸라"는 옛 안내는 그 축이 사라져 지웠다.
      detail: "이 계획이 각 회차에서 뽑을 수 있는 만큼 이미 채택했습니다"
        + " — 더 내보내려면 새 회차를 올리거나 하루 발행 수를 늘려 주세요.",
    };
  }

  if (o.scoreBlocked > 0) {
    // 점수 하한 축이 사라진 뒤(2026-08-26) 여기 남는 사유는 하나뿐이다: **점수가 없는 추천.**
    // selectCandidates 가 점수 없는 후보를 빼기 때문이고(모르면 안 내보낸다), 그건 기준을
    // 바꿔서 풀리는 게 아니라 회차를 다시 분석해야 채워진다.
    return {
      code: "score_blocked",
      detail: "추천에 점수가 없어 채택할 대상을 고르지 못했습니다 — 회차를 다시 분석하면 점수가 채워집니다.",
    };
  }

  if (o.kindMatched === 0 && o.pending > 0) {
    return {
      code: "kind_mismatch",
      detail: `이 계획이 만드는 종류(${MEDIA_KIND_LABEL[o.mediaKind]})에 맞는 추천이 없습니다`
        + " — 계획의 미디어 종류를 바꾸면 잡힙니다.",
    };
  }

  // 길이 상한 초과 — **겹침보다 먼저** 말한다. 겹침은 정상 동작이지만 이건 조치가 필요하고,
  // 조치가 다르다(재분석하면 상한 안으로 다시 뽑힌다 · 롱폼으로 낼 거면 방향을 가로형으로).
  if ((o.tooLong ?? 0) > 0) {
    return {
      code: "too_long",
      // 숫자(상한 초)는 일부러 안 쓴다 — 이 파일은 apps/web 이 함께 타입체크하는 무의존
      // 순수 모듈이라 channel-rules.ts 의 SHORTFORM_MAX_SEC 를 import 할 수 없고, 손으로
      // 적으면 정본과 갈라진다. 조치 안내만으로 사용자는 충분히 움직일 수 있다.
      detail: "숏폼으로 만들기엔 너무 긴 구간뿐이라 채택하지 못했습니다"
        + " — 회차를 다시 분석하면 상한 안으로 다시 뽑히고, 긴 구간 그대로 내보내려면"
        + " 계획의 방향을 가로형으로 바꿔 주세요.",
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
      detail: "이 계획이 만든 클립은 연결된 채널에 모두 나갔습니다 — 새 회차가 올라오면 이어서 만듭니다.",
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
 *  - 원본 없음(409) → 원본이 돌아오면 한 시간에 한 번 재확인(shouldRequestAutoRender)이 집어 간다.
 *  - 나머지(변환 실패·무응답) → 편집기에서 확정(렌더)을 다시 하면 그 클립은 렌더된 상태가 되고,
 *    다음 순방이 게시로 잇는다.
 */
export function renderFailureAction(status?: number | null, code?: string | null): string {
  if (code === "reframe_not_ready" || code === "reframe_plan_invalid") {
    // "AI" 를 쓰지 않는다 — 운영자 문구에 로마자를 섞지 않기로 한 계획(테스트가 강제).
    return "편집기 AI 리프레임 패널에서 다시 분석하거나 기본 모드를 선택한 뒤 확정(렌더)해 주세요.";
  }
  const s = Number(status ?? 0);
  if (s === 404) return "이미 지운 클립이면 그대로 두고, 필요하면 회차 화면에서 다시 채택해 주세요.";
  if (s === 400) return "편집기에서 클립 구간을 다시 지정한 뒤 내보내 주세요.";
  if (s === 409) return "원본 영상이 남아 있는지 확인해 주세요 — 원본을 되살리면 한 시간 안에 자동으로 다시 시도합니다.";
  if (s === 401 || s === 403) return "잠시 뒤에도 같으면 담당자에게 문의해 주세요.";
  return "한 시간에 한 번 자동으로 다시 시도합니다 — 편집기에서 확정(렌더)하면 더 빨리 이어집니다.";
}

/**
 * 확정 실패 후 자동 재시도 간격 — **1시간에 한 번** 다시 렌더를 건다.
 *
 * 예전엔 KST 날짜가 바뀌어야(하루 1회) 재확인했는데, 일시 장애(2026-08-26 ENA 실전:
 * stderr maxBuffer 초과)로 3회 실패해 확정되면 **그날 몫이 통째로 하루를 기다렸다** —
 * 무인 경로에 재시도 누를 사람이 없는데 "편집기에서 다시 확정해 주세요" 만 남는 건
 * 지킬 수 없는 안내다. 순방(15분)마다 다시 때리면 실패 폭주로 되돌아가므로 간격만 벌린다.
 */
export const RENDER_RETRY_COOLDOWN_MS = 60 * 60_000;

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
 * 확정 실패 뒤에도 **1시간에 한 번**은 다시 본다(RENDER_RETRY_COOLDOWN_MS) — 일시
 * 장애가 걷히거나 원본을 복구하면 사람이 편집기에서 다시 내보내지 않아도 되살아난다.
 * 재확인을 빼면 그 클립은 영원히 자동 경로 밖에 남고, 매 순방 다시 때리면 실패 폭주다.
 */
export function shouldRequestAutoRender(
  state: AutoRenderState | null | undefined,
  now: number,
): boolean {
  if (!state?.failed) return true;
  return now - state.lastAt >= RENDER_RETRY_COOLDOWN_MS;
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
  return `렌더가 ${state.attempts}회 실패했습니다`
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
  "렌더가 실패해 이 클립을 아직 게시하지 못했습니다"
  + " — 한 시간에 한 번 자동으로 다시 시도합니다. 편집기에서 확정(렌더)하면 바로 이어집니다.";

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

/** 계획 삭제 안내 (F6 ⚑ — 이미 게시된 건은 내려가지 않는다). */
export const RULE_DELETED_NOTICE =
  "계획을 지웠습니다. 이미 게시된 영상은 내려가지 않습니다 — 필요하면 채널에서 직접 내려야 합니다.";

export function isRuleMediaKind(v: unknown): v is RuleMediaKind {
  return typeof v === "string" && (RULE_MEDIA_KINDS as readonly string[]).includes(v);
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
export function isRuleAspect(v: unknown): v is RuleAspect {
  return typeof v === "string" && (RULE_ASPECTS as readonly string[]).includes(v);
}
