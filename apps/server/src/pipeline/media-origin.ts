/**
 * 미디어의 출처 — "채택(+)한 것만 미디어에 뜬다" (FLOWS F2-4).
 *
 * 영상 분석 화면의 추천 구간은 **후보**다. 사람이 +(채택)를 눌러야 미디어가 되고,
 * 누르지 않은 구간은 미디어 화면에 존재해서는 안 된다. 추천을 미디어처럼 보여주면
 * "아직 안 고른 것"과 "고른 것"이 섞여서, 배포 대상 선택이 곧 오배포가 된다.
 *
 * 이 모듈은 순수하다 — DB·env·네트워크를 타지 않는다. index.ts 는 최상위에서 serve() 를
 * 부르므로 테스트에서 import 할 수 없고, 그래서 규칙만 여기로 떼어 둔다.
 * (publish-guard.ts 와 같은 이유·같은 구조)
 */

export interface RecommendationLike {
  id: string;
  status?: string | null;
  /** 채택 시 생성된 클립 id. 채택 전에는 없다. */
  adoptedClipId?: string | null;
}

export interface ClipLike {
  id: string;
  /** 이 클립을 낳은 추천 구간. 채택 경로가 유일한 생성 경로이므로 항상 채워진다. */
  sourceRecommendationId?: string | null;
}

/**
 * 미디어 목록의 입력은 **클립뿐**이다.
 *
 * 추천 배열을 함께 받는 건 쓰기 위해서가 아니라, 호출부가 "추천도 합쳐야 하나?" 를
 * 고민하지 않게 하려고다 — 답은 언제나 아니오이고, 그 답을 시그니처에 박아 둔다.
 */
export function mediaListFrom<T extends ClipLike>(input: {
  clips: T[];
  recommendations?: RecommendationLike[];
}): T[] {
  return [...input.clips];
}

/** 채택된(=클립이 생긴) 추천인가. 미디어 화면이 아니라 분석 화면의 배지용. */
export function isAdopted(rec: RecommendationLike): boolean {
  return rec.status === "adopted" && Boolean(rec.adoptedClipId);
}

/**
 * 분석 화면에서 아직 사람이 판단하지 않은 구간 — F2 의 "미결정".
 * 거절(rejected)은 판단이 끝난 것이므로 미결정이 아니다.
 */
export function isUndecided(rec: RecommendationLike): boolean {
  const s = rec.status ?? "pending";
  return s !== "adopted" && s !== "rejected";
}

/**
 * 추천 구간의 미디어 생성 여부를 한 줄로. 화면 문구가 여기서 갈린다 —
 * "미디어 없음"(아직 안 누름)과 "제외함"(눌러서 거절함)은 다른 상태다.
 */
export function recommendationOutcome(
  rec: RecommendationLike,
): "adopted" | "rejected" | "undecided" {
  if (isAdopted(rec)) return "adopted";
  if ((rec.status ?? "pending") === "rejected") return "rejected";
  return "undecided";
}
