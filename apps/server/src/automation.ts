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

/**
 * 규칙 조건을 통과한 추천만 고른다 (F6 03단계).
 * 이미 판단된 것(채택·거절)은 다시 잡지 않는다 — 사람이 거절한 걸 자동이 되살리면 안 된다.
 */
export function selectCandidates(rule: AutomationRule, candidates: Candidate[]): Candidate[] {
  const undecided = candidates.filter((c) => (c.status ?? "pending") === "pending");

  const byKind = undecided.filter((c) => {
    if (rule.mediaKind === "both") return true;
    return rule.mediaKind === "short" ? c.kind === "short" : c.kind !== "short";
  });

  if (rule.criterion === "top3") {
    // 점수가 없는 후보는 상위 N 에서 뺀다 — 0점으로 치면 아무거나 올라온다.
    return byKind
      .filter((c) => typeof c.score100 === "number")
      .sort((a, b) => (b.score100 ?? 0) - (a.score100 ?? 0))
      .slice(0, 3);
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
