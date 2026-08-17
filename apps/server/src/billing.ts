/**
 * 과금 규칙. 순수 모듈.
 *
 * PG: 포트원 중계 + **KG이니시스** (2026-08-11 계약 완료).
 *
 * ## 과금 모델은 크레딧 선불 하나다 (2026-08-11 결정)
 * 월정액 + 초과분(계약형)은 **만들지 않기로 했다.** 그래서 이 파일에 있던
 * `checkQuota` · `buildInvoice` · `planLine` · `usageLine` · `Plan` · `VAT_RATE` 를 지웠다 —
 * 전부 자기 테스트에서만 호출되는 상태였고, 남겨 두면 다음 사람이 "있는 줄 알고" 배선해서
 * **과금 경로가 두 개**가 된다. 필요해지면 git 이력에서 꺼내되, 스키마부터 다시 볼 것.
 * `plans`·`subscriptions`·`invoices` 표는 남아 있지만 쓰지 않는다(migrations/0023 주석 참조).
 *
 * 실제 과금 동선: `POST /api/media/:id/analyze` → `creditBlockReason` → 402 →
 * `credits.ts checkCredits` 판정 → 분석 후 `content-pipeline` 이 `credit_ledger` 에 차감.
 *
 * ## 여기서 지키는 것
 * **멱등.** 워커는 재시도·중복 큐잉이 있는 구조다(job_queue 가 지수 백오프로 최대 5회).
 * 같은 분석이 두 번 기록되면 **한 번 분석하고 두 번 차감**한다. dedupe 키를 만드는 책임을
 * 여기 한 곳에 둔다.
 */

// ── 결제 설정 ────────────────────────────────────────────────────────────────────

/**
 * 포트원 연동에 필요한 env 가 다 있는가. 하나라도 비면 결제 경로를 열지 않는다.
 *
 * 이걸 안 보면 `storeId: ""` 가 브라우저 SDK 로 그대로 나가고, 사용자는 결제창에서
 * 원인을 알 수 없는 실패를 본다. **서버에서 먼저 막고 뭐가 빠졌는지 말하는 게 맞다.**
 */
export function portoneConfigured(env: NodeJS.ProcessEnv = process.env): { ok: boolean; missing: string[] } {
  const need = ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_CHANNEL_KEY", "PORTONE_WEBHOOK_SECRET"];
  const missing = need.filter((k) => !String(env[k] ?? "").trim());
  return { ok: missing.length === 0, missing };
}

// ── 사용량 ───────────────────────────────────────────────────────────────────────

export const USAGE_KINDS = ["analyze_minutes", "clip_render", "publish"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * 중복 과금 방지 키.
 *
 * 재분석은 **다시 원가가 드는 일**이라 별개 사용량이다. 그래서 attempt 를 키에 넣는다 —
 * 안 넣으면 재분석이 공짜가 되고, 매번 넣으면 워커 재시도가 중복 청구가 된다.
 * 여기서 말하는 attempt 는 "사람이 재분석을 시킨 횟수"지 워커의 재시도 횟수가 아니다.
 */
export function usageDedupeKey(kind: UsageKind, subjectId: string, attempt = 0): string {
  return attempt > 0 ? `${kind}:${subjectId}:${attempt}` : `${kind}:${subjectId}`;
}

/** 초 → 청구 분. **올림**이다 — 30초짜리도 파이프라인은 한 번 다 돈다. */
export function billableMinutes(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.ceil(durationSec / 60);
}

/**
 * 원가 — **분당 약 ₩40** (60분 회차 ≈ ₩2,385 · GEBD·썸네일 AI 방식 OFF 기준).
 * 2026-08-17 실측 확정: 32.4분 실회차 전 구간 + chyron 별도 실행(docs/ops/how-it-works.md §4).
 * 내역(60분 환산): Gemini ₩2,052(**화면자막 1,218** + 장면이해·서사 834) + Soniox ₩141 +
 * Cloud Run ₩142 + 렌더 ₩33 + TTS·임베딩 ₩17.
 *
 * **청구액이 아니라 마진 감시용**이다. 판매가는 크레딧 단가(`CREDIT_PRICE_KRW`=28)로 정한다 —
 * 1 크레딧 = 분석 1분이라 이 값과 바로 비교하면 그게 곧 마진이다.
 *
 * 🔴 **지금 이 값은 판매가보다 크다 = 편당 적자다**(₩28 받고 ₩40 쓴다). 숨기지 않고 그대로
 * 둔다 — 상수를 낮춰 흑자로 보이게 만드는 게 이 파일에서 이미 두 번 일어난 실패다.
 * 갈림길은 하나이고 **제품 결정**이다:
 *   · 화면 자막 읽기(`RUN_CHYRON_PER_SEG`, 프로덕션 기본 ON)를 끄면 → 분당 ₩18.7 · 마진 31%.
 *     대신 인물 검색축·화자 실명을 포기한다(그게 화자분리 오류를 교정하던 유일한 수단이다).
 *   · 켠 채로 흑자를 원하면 → 판매가가 분당 ₩42 이상이어야 한다.
 *   · Gemini 배치 모드(-50%)를 적용하면 켠 채로도 분당 ₩22.7 이 된다.
 * 결정이 내려지면 이 상수를 그 구성의 실측값으로 바꿀 것 (OFF 구성이면 19).
 *
 * ⚠️ 이력 — 같은 함정을 반복하지 않도록: 4.9(틀린 단가표) → 19 → 26(체크포인트 재개 로그라
 * chyron 누락 · 자막읽기를 추정 ₩405 로 메움) → **40**(실측 ₩1,218). 세 번 다 방향이 같았다:
 * **로그에 안 찍힌 스테이지를 0 으로 세서 원가를 낮게 봤다.**
 */
export const COST_KRW_PER_MINUTE = 40;

/**
 * 화면 자막 읽기(chyron)를 끈 구성의 원가 — 분당 ₩18.7 (60분 ≈ ₩1,124).
 * 위 갈림길의 다른 쪽 값이다. 두 값을 나란히 둬야 "끄면 얼마 남는지" 를 매번 다시
 * 계산하지 않는다. 대시보드는 `COST_KRW_PER_MINUTE` 를 쓴다.
 */
export const COST_KRW_PER_MINUTE_NO_CHYRON = 19;

export function estimatedCostKrw(minutes: number): number {
  return Math.round(minutes * COST_KRW_PER_MINUTE * 100) / 100;
}

// ── API 키 ───────────────────────────────────────────────────────────────────────

/**
 * 키 표시용 접두. **평문 전체는 발급 순간에만 보여주고 저장하지 않는다** —
 * 저장하면 DB 유출이 곧 남의 채널에 영상을 올릴 수 있는 권한이 된다.
 */
export function apiKeyPrefix(raw: string): string {
  // `stepd_live_` (11자) + 4자 = 15자. 계획 §2 의 예시(`stepd_live_ab12`)와 같은 길이다.
  return raw.slice(0, 15);
}

/** 라이브 키인가 — 테스트 키로 실제 청구가 일어나면 안 된다. */
export function isLiveApiKey(raw: string): boolean {
  return raw.startsWith("stepd_live_");
}
