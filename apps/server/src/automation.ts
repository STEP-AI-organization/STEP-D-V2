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
  /** 템플릿 위치 미세조정(%·px) — 자동배포 화면 슬라이더. 시드 기본값 위에 덮인다. */
  layout?: { titleY?: number; channelIconY?: number; channelBoxY?: number; channelIconSize?: number };
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
  /** 채택 방향 — 수동 채택과 같은 값. 미지정 = 기존처럼 추천 kind 로 결정(하위호환). */
  orientation?: RuleOrientation | null;
  /** 'ai' = 세로형 채택 직후 AI 리프레임(clip.reframe) 큐잉. 세로형일 때만 의미. */
  reframe?: RuleReframe | null;
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
 * 지금이 활동 시간창(KST) 안인가. end 는 배타 — 9~22 면 09:00:00 ≤ t < 22:00:00.
 * start·end 가 같으면 24시간으로 본다 (창 없음 의미).
 */
export function inActiveWindow(rule: AutomationRule, now = new Date()): boolean {
  const start = Number.isFinite(rule.activeStart) ? Number(rule.activeStart) : 9;
  const end = Number.isFinite(rule.activeEnd) ? Number(rule.activeEnd) : 22;
  if (start === end) return true;
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", hour: "numeric", hour12: false,
  }).format(now));
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * 규칙 생성 시 상태 분기 (F6).
 * YouTube 만 실제로 올라가므로, 그 외 채널의 규칙은 처음부터 `기록만`이라고 말한다.
 */
export function initialRuleState(platform: string, enabled = true): RuleState {
  if (!enabled) return "paused";
  return platform === "youtube" ? "running" : "record_only";
}

/** 규칙 생성 토스트 문구 (F6 ⚑ — 기록만 하는 채널은 반드시 알린다). */
export function ruleCreatedNotice(platform: string): string {
  return platform === "youtube"
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

  const byKind = undecided.filter((c) => {
    if (rule.mediaKind === "both") return true;
    return rule.mediaKind === "short" ? c.kind === "short" : c.kind !== "short";
  });

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
  return byKind.filter((c) => typeof c.score100 === "number" && (c.score100 as number) >= floor);
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
