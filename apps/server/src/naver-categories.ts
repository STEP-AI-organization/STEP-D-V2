/**
 * 네이버 클립 카테고리 분류표 — 1차 40개 / 2차 144개.
 *
 * ## 왜 표를 들고 있나
 *
 * 카테고리는 클립 등록의 **필수값**이고, 1차·2차를 둘 다 골라야 저장이 활성화된다.
 * 예전엔 사람이 화면에 문자열을 직접 쳐 넣었고, 그 문자열이 실제 목록에 없으면
 * `pickCategory` 가 **목록의 첫 항목을 대신 골랐다**. 그러면 잘못된 분류로 발행되는데
 * 아무도 모른다 — 화면은 "발행 완료" 라고 말한다. 되돌리려면 네이버에서 손으로 고쳐야 한다.
 *
 * 표가 있으면 세 가지가 가능해진다:
 *  1. **브라우저를 열기 전에** 틀린 값을 잡는다(업로드 낭비 없이, 원인이 분명한 메시지로).
 *  2. 화면이 자유입력 대신 드롭다운을 준다 — 애초에 틀린 값을 못 넣는다.
 *  3. 장르에서 기본값을 유도한다(드라마 → 엔터/드라마).
 *
 * ## 이 표는 스냅샷이다
 *
 * `scripts/naver-categories.mts` 가 클립 스튜디오의 editor-meta API 에서 받아 저장한다
 * (2026-08-28 캡처). 네이버가 분류를 바꾸면 **여기가 낡는다** — 그래서 이 표를 통과한
 * 값이라도 `pickCategory` 가 화면에서 한 번 더 확인한다. 표는 사람의 실수를 막는 1차
 * 방어일 뿐, 진실의 근거는 언제나 화면이다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type NaverSubCategory = { no: number; code: string; name: string };
export type NaverCategory = NaverSubCategory & { subs: NaverSubCategory[] };
export type CategoryPick = { primary: string; secondary: string };

type Snapshot = { source: string; capturedAt: number; categories: NaverCategory[] };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT: Snapshot = JSON.parse(
  readFileSync(path.join(HERE, "data", "naver-clip-categories.json"), "utf8"),
);

/** 캡처 원본 정보 — 화면·문서에서 "언제 기준 표인가" 를 보여줄 때 쓴다. */
export const CATEGORY_SOURCE = { url: SNAPSHOT.source, capturedAt: SNAPSHOT.capturedAt };

export function listCategories(): NaverCategory[] {
  return SNAPSHOT.categories;
}

/**
 * 이름 비교용 정규화. 네이버 2차 이름에는 `스타, 연예인` 처럼 쉼표·공백이 들어 있어서,
 * 사람이 옮겨 적으면 `스타,연예인` 이 되기 쉽다. 그 정도 차이로 발행을 막을 이유는 없다.
 */
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export type ResolveResult =
  | { ok: true; category: CategoryPick; primaryNo: number; secondaryNo: number }
  | { ok: false; reason: string };

/**
 * 사람이 넣은 1차/2차 문자열을 표의 정식 이름으로 맞춘다.
 *
 * 실패는 **던지지 않고 이유를 돌려준다** — 호출부(발행 워커)가 그 문장을 그대로 배포 실패
 * 사유로 남겨야 사람이 화면에서 원인을 읽을 수 있다. 던져서 스택으로 만들면 "알 수 없는
 * 오류" 가 된다.
 */
export function resolveCategory(primary: string, secondary: string): ResolveResult {
  const p = SNAPSHOT.categories.find((c) => norm(c.name) === norm(primary));
  if (!p) {
    return {
      ok: false,
      reason: `1차 카테고리 "${primary}" 는 네이버 클립에 없다. 가능한 값: ${
        SNAPSHOT.categories.map((c) => c.name).join(" · ")
      }`,
    };
  }
  const s = p.subs.find((x) => norm(x.name) === norm(secondary));
  if (!s) {
    return {
      ok: false,
      reason: `"${p.name}" 의 2차 카테고리에 "${secondary}" 가 없다. 가능한 값: ${
        p.subs.map((x) => x.name).join(" · ")
      }`,
    };
  }
  return {
    ok: true,
    category: { primary: p.name, secondary: s.name },
    primaryNo: p.no,
    secondaryNo: s.no,
  };
}

/**
 * 장르 → 카테고리 기본값. 우리가 특화한 두 장르만 명시로 매핑하고, 나머지는 엔터/엔터다.
 *
 * ⚠️ **자동 판정이 아니다.** 장르는 사람이 프로그램에 지정한 값이고(자동판정은 폴백),
 * 그 사람의 지정을 카테고리로 옮겨 주는 것뿐이다. 여기서 영상 내용을 보고 분류를 추측하지
 * 않는다 — 틀리면 발행된 뒤에야 알게 되고, 사람이 고를 때보다 나을 근거가 없다.
 *
 * 문자열 판정은 `clip-metadata.ts` 의 `genrePackFor` 와 같은 규칙을 쓴다. 둘이 어긋나면
 * "제목은 드라마 톤인데 카테고리는 예능" 같은 어긋남이 생긴다.
 */
export function categoryForGenre(genre?: string | null): CategoryPick {
  const g = (genre ?? "").toLowerCase();
  if (g.includes("drama") || g.includes("드라마") || g.includes("영화")) {
    return { primary: "엔터", secondary: "드라마" };
  }
  if (g.includes("variety") || g.includes("예능")) {
    return { primary: "엔터", secondary: "예능" };
  }
  return DEFAULT_CATEGORY;
}

/**
 * 최후 기본값. 장르도 프로그램 설정도 없을 때만 쓴다.
 * 방송사 클립은 대부분 엔터로 묶이므로 크게 틀리지 않는다 — 그래도 **정확한 분류는
 * 프로그램별로 한 번 정하는 것**이지 이 값에 기대는 게 아니다.
 */
export const DEFAULT_CATEGORY: CategoryPick = { primary: "엔터", secondary: "엔터" };
