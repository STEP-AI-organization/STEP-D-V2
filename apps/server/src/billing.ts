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
 * 실측 원가 — **분당 ₩17.0** (58.6분 회차 ≈ ₩994 · GEBD·썸네일 OFF 기준).
 * 내역: Gemini ₩728 + Soniox ₩138 + Cloud Run ₩125 + 임베딩 ₩3.
 *
 * **청구액이 아니라 마진 감시용**이다. 판매가는 크레딧 단가(`CREDIT_PRICE_KRW`=28)로 정한다 —
 * 1 크레딧 = 분석 1분이라 이 값과 바로 비교하면 그게 곧 마진이다(현재 ₩28 대비 39%).
 *
 * ⚠️ 예전 값 4.9 는 **₩285/회차**라는 틀린 원가에서 나온 것이었다. 그 ₩285 는 `core/common/
 * retry.py` 단가표가 Gemini 2.0 Flash 가격을 2.5 Flash 라벨에 붙여 4.7배 과소계상한 결과다
 * (docs/ops/cost-and-dependencies.md §4). 그대로 두면 대시보드가 "마진 5.7배" 라고 보고하지만
 * 실제는 1.65배다 — **가격 결정은 우연히 옳았고 계측만 고장나 있었다.**
 * 안전쪽으로 19 를 쓴다(실측 17.0 + 렌더·부대 여유).
 */
export const COST_KRW_PER_MINUTE = 19;

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
