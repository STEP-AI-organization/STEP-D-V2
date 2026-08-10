/**
 * 게이트 어휘 — 화면 전체가 같은 말을 쓰게 하는 곳 (FLOWS F3).
 *
 * 판정은 서버가 한다. 여기 있는 건 **표시**뿐이다 — 라벨·톤·색.
 * 화면이 자기 나름대로 "이 정도면 통과 아닌가"를 계산하면, 서버 판정과 어긋난 순간
 * 사용자는 화면을 믿고 눌렀는데 막히는 경험을 하게 된다.
 */
import type { GateState, IssueKind, IssueResolution } from "@/lib/data/api";

export const GATE_LABEL: Record<GateState, string> = {
  pass: "통과",
  rights_hold: "권리 홀드",
  conditional: "조건부 처리",
  review_pending: "검수 대기",
  blocked: "차단",
};

/** sd-tag 변형 클래스. 통과만 초록, 나머지는 각자 다른 경고 톤. */
export const GATE_TAG: Record<GateState, string> = {
  pass: "sd-tag sd-tag--airing",
  rights_hold: "sd-tag sd-tag--danger",
  conditional: "sd-tag sd-tag--warn",
  review_pending: "sd-tag",
  blocked: "sd-tag sd-tag--danger",
};

/** 타임라인 레인 색 — 구간 이슈를 원본 길이 위에 겹쳐 그릴 때. */
export const ISSUE_COLOR: Record<IssueKind, string> = {
  music: "#7b5ea7",
  portrait: "#b03328",
  ppl: "#96690c",
  cast_hold: "#8f2f24",
  brand_blur: "#1c7a52",
  vod_window: "#4b74d8",
};

export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  music: "음원",
  portrait: "초상(출연자)",
  ppl: "PPL·간접광고",
  cast_hold: "출연자 홀드",
  brand_blur: "브랜드 블러",
  vod_window: "VOD 윈도우",
};

export const ISSUE_KINDS: IssueKind[] = [
  "music",
  "portrait",
  "ppl",
  "cast_hold",
  "brand_blur",
  "vod_window",
];

export const RESOLUTION_LABEL: Record<IssueResolution, string> = {
  open: "미해결",
  conditional: "조건부 — 조치 필요",
  resolved: "해제됨",
  blocked: "배포 불가",
};

/** 등록 시 고를 수 있는 값. `resolved` 는 없다 — 등록과 동시에 해제는 판정이 아니다. */
export const REGISTERABLE_RESOLUTIONS: Exclude<IssueResolution, "resolved">[] = [
  "open",
  "conditional",
  "blocked",
];

/** 초 → mm:ss (한 시간 넘으면 h:mm:ss). */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
