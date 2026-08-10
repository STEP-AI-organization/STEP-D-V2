/**
 * 프로그램 목록 도메인 규칙 (FLOWS F10 · README §2).
 *
 * 30개 이상 프로그램을 운영하는 화면이라 필터가 먼저 온다. 여기서 지켜야 할 규칙 둘:
 *
 *  1. 필터 라벨의 개수는 **다른 필터를 적용한 뒤 남는 개수**다(전체 개수 아님).
 *     "종영 12"가 아니라 "지금 걸린 검색어·섹션·담당 조건에서 종영 3"이어야,
 *     눌렀을 때 빈 화면이 나오지 않는다.
 *  2. 상태별로 카드 내용이 다르다 — 종영은 클립 생성 단계가 없고,
 *     편성 예정은 첫 방송 전이라 회차 수를 보여줄 게 없다.
 *
 * 순수 함수만 둔다(React 없음). 화면은 이 결과를 그리기만 한다.
 */
import type { Program, ProgramStatus } from "@/lib/types";

export const PROGRAM_STATUSES: ProgramStatus[] = ["airing", "ended", "upcoming"];

export const PROGRAM_STATUS_LABEL: Record<ProgramStatus, string> = {
  airing: "방영 중",
  ended: "종영",
  upcoming: "편성 예정",
};

/**
 * 구버전 저장값 흡수. `active`→방영 중, `archived`→종영.
 * 모르는 값은 방영 중으로 본다 — 목록에서 사라지는 것보다 낫다.
 */
export function normalizeProgramStatus(raw: Program["status"] | undefined): ProgramStatus {
  switch (raw) {
    case "ended":
    case "archived":
      return "ended";
    case "upcoming":
      return "upcoming";
    default:
      return "airing";
  }
}

// ── 권리 윈도우 ──────────────────────────────────────────────────────────────────

/** 만료 임박으로 볼 잔여 일수. 프로토타입의 D-6·D-21이 모두 경고 톤이었다. */
export const RIGHTS_EXPIRING_DAYS = 30;

export interface RightsWindow {
  text: string;
  /** 만료 임박·만료됨 — 카드에서 레드 톤. */
  expiring: boolean;
  /** 남은 일수. 만료일이 없으면 null, 이미 지났으면 음수. */
  daysLeft: number | null;
}

function parseISODate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * 카드·대시보드에 붙는 권리 태그 (F3 "권리 윈도우 만료 임박은 경고 톤으로 노출").
 *
 * ⚠️ 경고까지가 전부다. 만료됐다고 배포가 자동으로 막히지 않는다 —
 * 게이트는 사람이 등록한 이슈로만 걸린다(F3 "자동 판정 없음").
 */
export function rightsWindowOf(program: Program, today: Date): RightsWindow | null {
  const note = program.rightsNote?.trim();
  const until = program.rightsUntil?.trim();
  if (!until) return note ? { text: note, expiring: false, daysLeft: null } : null;

  const untilMs = parseISODate(until);
  if (untilMs === null) return { text: note ?? until, expiring: false, daysLeft: null };

  const todayMs = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const daysLeft = Math.round((untilMs - todayMs) / 86_400_000);

  if (daysLeft < 0) {
    return { text: `권리 만료됨 · ${until}${note ? ` · ${note}` : ""}`, expiring: true, daysLeft };
  }
  if (daysLeft <= RIGHTS_EXPIRING_DAYS) {
    return { text: `만료 D-${daysLeft}${note ? ` · ${note}` : " · 재계약 확인"}`, expiring: true, daysLeft };
  }
  return { text: `디지털 권리 ${until}`, expiring: false, daysLeft };
}

// ── 필터 ─────────────────────────────────────────────────────────────────────────

export interface ProgramFilters {
  /** 프로그램명 · 담당 PD · 섹션에 걸리는 검색어. */
  q: string;
  /** 섹션. "전체"면 미적용. */
  section: string;
  /** 편성 상태. "전체"면 미적용. */
  status: ProgramStatus | "전체";
  mineOnly: boolean;
}

export const ALL = "전체";

export const EMPTY_PROGRAM_FILTERS: ProgramFilters = {
  q: "",
  section: ALL,
  status: ALL,
  mineOnly: false,
};

const matchQuery = (p: Program, q: string) => {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${p.title} ${p.owner ?? ""} ${p.section}`.toLowerCase().includes(needle);
};

const matchSection = (p: Program, section: string) => section === ALL || p.section === section;

const matchStatus = (p: Program, status: ProgramFilters["status"]) =>
  status === ALL || normalizeProgramStatus(p.status) === status;

/** 담당자는 이름 문자열로 붙는다 — 계정 시스템이 생기면 여기만 userId 비교로 바꾼다. */
const matchMine = (p: Program, mineOnly: boolean, me: string) =>
  !mineOnly || (Boolean(p.owner) && p.owner === me);

export function filterPrograms(programs: Program[], f: ProgramFilters, me: string): Program[] {
  return programs.filter(
    (p) =>
      matchQuery(p, f.q) &&
      matchSection(p, f.section) &&
      matchStatus(p, f.status) &&
      matchMine(p, f.mineOnly, me),
  );
}

export interface ResidualCounts {
  /** 상태 필터 라벨용 — 자기 축(status)만 빼고 나머지를 적용한 결과. */
  status: Record<string, number>;
  section: Record<string, number>;
  /** "내 담당만"을 눌렀을 때 남을 개수. */
  mine: number;
  /** 현재 필터 전부 적용 후 개수. */
  total: number;
}

/**
 * F10 — 각 필터 옵션 라벨에 붙일 개수.
 *
 * 핵심은 **자기 축을 제외**하는 것이다. 상태 라벨의 개수를 셀 때 현재 상태 필터는 무시하고
 * 검색어·섹션·담당만 적용한다. 그래야 "종영 3"을 누르면 정말 3개가 남는다.
 */
export function residualCounts(
  programs: Program[],
  f: ProgramFilters,
  me: string,
): ResidualCounts {
  const statusBase = programs.filter(
    (p) => matchQuery(p, f.q) && matchSection(p, f.section) && matchMine(p, f.mineOnly, me),
  );
  const sectionBase = programs.filter(
    (p) => matchQuery(p, f.q) && matchStatus(p, f.status) && matchMine(p, f.mineOnly, me),
  );
  const mineBase = programs.filter(
    (p) => matchQuery(p, f.q) && matchSection(p, f.section) && matchStatus(p, f.status),
  );

  const status: Record<string, number> = { [ALL]: statusBase.length };
  for (const s of PROGRAM_STATUSES) {
    status[s] = statusBase.filter((p) => normalizeProgramStatus(p.status) === s).length;
  }

  const section: Record<string, number> = { [ALL]: sectionBase.length };
  for (const p of sectionBase) section[p.section] = (section[p.section] ?? 0) + 1;

  return {
    status,
    section,
    mine: mineBase.filter((p) => Boolean(p.owner) && p.owner === me).length,
    total: filterPrograms(programs, f, me).length,
  };
}

/**
 * 섹션 목록은 데이터에서 뽑는다 — 이 리포는 예능·드라마·시사 말고도
 * 뮤직·교양·라이프·스포츠를 쓴다. 목록에 없는 섹션이 필터에서 빠지면 못 찾는다.
 */
export function sectionsOf(programs: Program[]): string[] {
  const seen = new Map<string, number>();
  for (const p of programs) seen.set(p.section, (seen.get(p.section) ?? 0) + 1);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
    .map(([s]) => s);
}

/**
 * 상태 필터를 좁혔을 때 화면에 띄울 안내. 종영·편성 예정은 "왜 할 일이 없는지"를
 * 적어 주지 않으면 고장으로 읽힌다.
 */
export function statusNoteFor(status: ProgramFilters["status"]): string | null {
  if (status === "ended") {
    return "종영작은 새 회차가 들어오지 않습니다 — 기존 회차 재활용과 권리 만료일만 관리합니다. 아카이브 검색으로 찾은 구간은 그대로 클립으로 만들 수 있습니다.";
  }
  if (status === "upcoming") return "첫 방송 전이라 분석할 회차가 없습니다.";
  return null;
}
