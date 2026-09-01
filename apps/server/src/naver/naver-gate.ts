/**
 * 네이버 실업로드 게이트 (기본값 OFF) — youtube 의 upload-gate.ts 와 같은 방침.
 *
 * SAFE BY DEFAULT: `NAVER_UPLOAD_ENABLED` 가 명시적으로 truthy 일 때만 ON. 미설정·오타·빈값은
 * 전부 OFF 다. 잘못된 env 의 실패 모드가 "업로드 안 됨"이어야지 "실수로 업로드됨"이면 안 된다.
 * 네이버는 되돌리기가 더 어렵다 — 삭제해도 노출 이력이 남고, 자동화 자체가 약관 리스크다.
 *
 * 호출 시점에 읽는다(모듈 로드 시점 아님) — 재배포/재시작만으로 플래그를 뒤집을 수 있게.
 */
const TRUTHY = new Set(["true", "1", "on", "yes", "enabled"]);

export function naverUploadEnabled(): boolean {
  return TRUTHY.has(String(process.env.NAVER_UPLOAD_ENABLED ?? "").trim().toLowerCase());
}

export const NAVER_DISABLED_CODE = "naver_upload_disabled";
export const NAVER_DISABLED_MESSAGE =
  "네이버 업로드가 꺼져 있습니다. 워커 PC 에서 NAVER_UPLOAD_ENABLED=1 로 켜세요.";

/**
 * 클립 설명 길이(2026-08-11 실측). 10자 미만이면 등록 버튼 자체가 막힌다.
 *
 * ⚠️ 이 상수가 naver-tv.ts 가 아니라 여기 있는 이유: naver-tv.ts 는 top-level 에서
 * playwright 를 import 한다. 라우트(index.ts)가 거기서 상수를 가져오면 **Cloud Run 서버가
 * playwright 를 통째로 끌고 들어간다** — 서버에는 브라우저가 없다. 워커 전용 의존성이
 * HTTP 프로세스로 새지 않게, 순수 상수는 게이트 쪽에 둔다.
 */
export const DESC_MIN = 10;
export const DESC_MAX = 300;

/** 바이트가 나가기 직전에 부른다. 라우트에서만 막으면 워커 경로가 뚫린다. */
export function assertNaverUploadEnabled(): void {
  if (!naverUploadEnabled()) throw new Error(NAVER_DISABLED_MESSAGE);
}
