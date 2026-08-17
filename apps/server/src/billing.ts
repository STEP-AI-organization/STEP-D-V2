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
 * 원가 — **분당 약 ₩19** (60분 회차 ≈ ₩1,124).
 *
 * **지금 프로덕션 구성 기준이다**: 화면 자막 읽기 OFF · GEBD OFF · 썸네일 프레임 방식.
 * `stepd-worker-content` 잡 env 에 `RUN_CHYRON_PER_SEG=0` 이 들어 있다(2026-08-17 확인).
 * 내역(60분 환산): Gemini ₩834(장면이해·구간선정·서사) + Soniox ₩141 + Cloud Run ₩99 +
 * 렌더 ₩33 + TTS·임베딩 ₩17. → 판매가 ₩28/분 대비 **마진 31%**.
 *
 * **청구액이 아니라 마진 감시용**이다. 판매가는 크레딧 단가(`CREDIT_PRICE_KRW`=28)로 정한다 —
 * 1 크레딧 = 분석 1분이라 이 값과 바로 비교하면 그게 곧 마진이다.
 *
 * ⚠️ **자막 읽기를 켜면 이 값이 두 배가 된다**(분당 ₩39.8 · 편당 ₩759 적자).
 * 배치 모드(`GEMINI_BATCH=1`)를 같이 켜면 분당 ₩28.9 로 거의 본전이다. 켤 이유는 비용이
 * 아니라 품질이다 — 그게 화자분리 오류를 교정해 인물 검색축을 만드는 유일한 수단이다
 * (docs/ops/how-it-works.md §4). 구성을 바꾸면 이 상수도 같이 바꿀 것.
 *
 * ⚠️ 이력 — 같은 함정을 반복하지 않도록: 4.9(틀린 단가표) → 19 → 26(체크포인트 재개 로그라
 * chyron 누락 · 추정 ₩405 로 메움) → 40(실측 ₩1,218 · **프로덕션이 그걸 켜고 있다고 오판**)
 * → **19**(프로덕션 잡 env 를 실제로 조회 · chyron OFF 확인). 원가를 인용하기 전에
 * **어느 구성의 값인지**를 먼저 말할 것 — 네 번 다 여기서 틀렸다.
 */
export const COST_KRW_PER_MINUTE = 19;

/**
 * 화면 자막 읽기를 **켠** 구성의 원가 — 분당 ₩39.8 (60분 ≈ ₩2,385 · 배치 OFF).
 * 배치 모드까지 켜면 분당 ₩28.9. 두 값을 나란히 둬야 "켜면 얼마 드는지" 를 매번
 * 다시 계산하지 않는다. 대시보드는 `COST_KRW_PER_MINUTE` 를 쓴다.
 */
export const COST_KRW_PER_MINUTE_WITH_CHYRON = 40;

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
