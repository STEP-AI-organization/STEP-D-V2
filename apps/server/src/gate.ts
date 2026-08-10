/**
 * 게이트 판정 — 이 제품의 핵심 규칙 (FLOWS F3). 순수 모듈.
 *
 * 규칙 셋만 기억하면 된다:
 *
 *  1. **자동 판정 없음.** 이 파일 어디에도 "영상을 보고 이슈를 찾는" 코드는 없다.
 *     사람이 등록한 것만 근거로 게이트를 건다.
 *  2. **미판정 ≠ 이슈 없음.** 아무도 안 본 미디어는 `검수 대기`지 `통과`가 아니다.
 *     통과하려면 "이슈 없음"이라는 명시적 판정이 있어야 한다(F2 Invariant).
 *  3. **조건부는 조치 확인 전까지 통과가 아니다.** "블러 처리 완료" 같은 근거 문장이
 *     달려야 resolved 로 바뀐다.
 *
 * 상태를 저장하지 않는다 — 판정할 때마다 계산한다. 캐시 필드를 두면 그 필드를 덮어써
 * 통과시킬 수 있고, 그 순간 "어떤 경로로도 게시되지 않는다"가 깨진다.
 */

/** 이슈 종류 (FLOWS.md:59). */
export const ISSUE_KINDS = [
  "music",
  "portrait",
  "ppl",
  "cast_hold",
  "brand_blur",
  "vod_window",
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  music: "음원",
  portrait: "초상(출연자)",
  ppl: "PPL·간접광고",
  cast_hold: "출연자 홀드",
  brand_blur: "브랜드 블러 구간",
  vod_window: "VOD 윈도우",
};

/** 이슈의 처리 상태. */
export const RESOLUTIONS = ["open", "conditional", "resolved", "blocked"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** 게이트 상태 (FLOWS.md:57). */
export type GateState = "pass" | "rights_hold" | "conditional" | "review_pending" | "blocked";

export const GATE_LABEL: Record<GateState, string> = {
  pass: "통과",
  rights_hold: "권리 홀드",
  conditional: "조건부 처리",
  review_pending: "검수 대기",
  blocked: "차단",
};

export interface Issue {
  id: string;
  kind: IssueKind | string;
  resolution: Resolution | string;
  bandStart?: number | null;
  bandEnd?: number | null;
  note?: string;
}

export interface GateResult {
  state: GateState;
  label: string;
  /** 게시해도 되는가. `pass` 하나만 true 다. */
  allowed: boolean;
  /** 사람에게 보여줄 사유. 통과면 빈 문자열. */
  reason: string;
  /** 게이트를 잡고 있는 이슈들 (사유 표시·감사 로그 근거용). */
  blocking: Issue[];
}

export function isIssueKind(v: unknown): v is IssueKind {
  return typeof v === "string" && (ISSUE_KINDS as readonly string[]).includes(v);
}

export function isResolution(v: unknown): v is Resolution {
  return typeof v === "string" && (RESOLUTIONS as readonly string[]).includes(v);
}

/**
 * 게이트 판정.
 *
 * `judged` 는 "이슈 없음"이라는 명시적 판정 기록의 존재다. 이슈를 하나라도 등록했다면
 * 그 자체가 사람의 판단이므로 판정된 것으로 본다.
 *
 * 우선순위: 차단 > 권리 홀드 > 조건부 > 검수 대기 > 통과.
 * 가장 나쁜 것이 이긴다 — 여러 이슈가 섞였을 때 통과 쪽으로 기울면 안 된다.
 */
export function evaluateGate(input: { judged: boolean; issues: Issue[] }): GateResult {
  const issues = input.issues ?? [];
  const live = issues.filter((i) => i.resolution !== "resolved");

  const blocked = live.filter((i) => i.resolution === "blocked");
  if (blocked.length > 0) {
    return {
      state: "blocked",
      label: GATE_LABEL.blocked,
      allowed: false,
      reason: `배포 불가 판정 ${blocked.length}건 — ${describe(blocked)}`,
      blocking: blocked,
    };
  }

  const open = live.filter((i) => i.resolution === "open");
  if (open.length > 0) {
    return {
      state: "rights_hold",
      label: GATE_LABEL.rights_hold,
      allowed: false,
      reason: `미해결 권리·심의 이슈 ${open.length}건 — ${describe(open)}`,
      blocking: open,
    };
  }

  const conditional = live.filter((i) => i.resolution === "conditional");
  if (conditional.length > 0) {
    return {
      state: "conditional",
      label: GATE_LABEL.conditional,
      allowed: false,
      reason: `조치 확인이 필요한 이슈 ${conditional.length}건 — ${describe(conditional)}`,
      blocking: conditional,
    };
  }

  // 알려진 세 상태 중 어디에도 안 걸렸는데 아직 남아 있는 이슈 = resolution 값이
  // 이상한 것(오타·미래에 추가된 값·손으로 고친 행). **모르면 막는다.**
  // 여기서 통과 쪽으로 흘려보내면 게이트가 fail-open 이 된다.
  if (live.length > 0) {
    return {
      state: "rights_hold",
      label: GATE_LABEL.rights_hold,
      allowed: false,
      reason: `해석할 수 없는 처리 상태 ${live.length}건 — ${[...new Set(live.map((i) => String(i.resolution)))].join(", ")}`,
      blocking: live,
    };
  }

  // 여기부터는 미해결 이슈가 없다. 그래도 아무도 안 봤으면 통과가 아니다.
  const judged = input.judged || issues.length > 0;
  if (!judged) {
    return {
      state: "review_pending",
      label: GATE_LABEL.review_pending,
      allowed: false,
      reason: "권리·심의 검수 전입니다 — 이슈가 없다는 판정도 사람이 남겨야 합니다",
      blocking: [],
    };
  }

  return { state: "pass", label: GATE_LABEL.pass, allowed: true, reason: "", blocking: [] };
}

function describe(issues: Issue[]): string {
  const names = issues.map((i) => ISSUE_KIND_LABEL[i.kind as IssueKind] ?? i.kind);
  const uniq = [...new Set(names)];
  return uniq.slice(0, 3).join(", ") + (uniq.length > 3 ? " 외" : "");
}

/**
 * 조건부 이슈를 통과로 바꿀 수 있는가 (F3 — "'블러 처리 완료' 같은 조치 확인 후에만").
 *
 * 근거 문장 없이 해제되면 감사 로그에 "왜 통과시켰는지"가 안 남는다. 그러면 나중에
 * 문제가 터졌을 때 되짚을 수가 없다.
 */
export function canResolve(issue: Issue, resolutionNote: string): { ok: boolean; reason: string } {
  const note = (resolutionNote ?? "").trim();
  if (issue.resolution === "resolved") return { ok: false, reason: "이미 해제된 이슈입니다" };
  if (note.length < 2) {
    return { ok: false, reason: "해제 근거를 적어야 합니다 (예: 블러 처리 완료, 음원 교체 완료)" };
  }
  return { ok: true, reason: "" };
}

// ── 승계 (F2-4) ──────────────────────────────────────────────────────────────────

/** 두 구간이 겹치는가. 접점만 닿는 건(끝=시작) 겹침이 아니다. */
export function overlaps(
  a: { start: number; end: number },
  b: { start?: number | null; end?: number | null },
): boolean {
  // 밴드가 없는 이슈는 대상 전체에 걸린 것 — 무조건 겹친다.
  if (b.start == null || b.end == null) return true;
  return Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0;
}

/**
 * 채택 시 미디어가 물려받을 이슈를 고른다 (F2-4 · F2 Invariant).
 *
 * "이슈가 승계되지 않은 미디어는 존재할 수 없다." 승계할 이슈가 0건이어도
 * **판정 자체는 승계된다** — 원본이 판정됐으면 잘라낸 구간도 판정된 것으로 본다.
 * 안 그러면 채택할 때마다 모든 미디어가 `검수 대기`로 되돌아간다.
 */
export function inheritedIssues(
  segment: { start: number; end: number },
  sourceIssues: Issue[],
): Issue[] {
  return sourceIssues.filter(
    (i) => i.resolution !== "resolved" && overlaps(segment, { start: i.bandStart, end: i.bandEnd }),
  );
}

// ── 일괄 처리 (F3 동작) ──────────────────────────────────────────────────────────

export interface ScreenedBatch<T> {
  passed: T[];
  blocked: { item: T; gate: GateResult }[];
}

/**
 * 선택 묶음에서 통과 건만 골라낸다.
 *
 * ⊘ 조용히 제외 금지 · ⊘ 전체 실패 처리 금지 (FLOWS.md:70).
 * 그래서 제외된 것을 버리지 않고 사유와 함께 돌려준다 — 호출부가 토스트로 알려야 한다.
 */
export function screenBatch<T>(items: T[], gateOf: (item: T) => GateResult): ScreenedBatch<T> {
  const passed: T[] = [];
  const blocked: { item: T; gate: GateResult }[] = [];
  for (const item of items) {
    const gate = gateOf(item);
    if (gate.allowed) passed.push(item);
    else blocked.push({ item, gate });
  }
  return { passed, blocked };
}

/** 제외 안내 문구 — 몇 건이 왜 빠졌는지. 빈 문자열이면 알릴 게 없다. */
export function exclusionNotice(blocked: { gate: GateResult }[]): string {
  if (blocked.length === 0) return "";
  const byState = new Map<GateState, number>();
  for (const b of blocked) byState.set(b.gate.state, (byState.get(b.gate.state) ?? 0) + 1);
  const parts = [...byState.entries()].map(([s, n]) => `${GATE_LABEL[s]} ${n}건`);
  return `게이트 미통과 ${blocked.length}건을 제외했습니다 — ${parts.join(" · ")}`;
}
