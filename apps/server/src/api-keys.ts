/**
 * 회사별 API 키 — 고객사 시스템이 우리를 호출하는 경로 (다회사 3단계).
 *
 * ## 격리를 두 벌 만들지 않는다
 * 키 인증도 **세션과 똑같이 `app.tenant_id` 를 세우는 길**을 지난다(index.ts `resolveTenant`).
 * RLS 가 이미 격리를 담당하므로, 키 경로가 그걸 우회해서 자체 필터를 갖기 시작하면
 * 격리 로직이 두 벌이 되고 **한 벌은 반드시 샌다.** 여기서 하는 일은 "이 키가 누구 것인가"를
 * 정하는 것까지고, 그 뒤는 기존 경로와 완전히 같다.
 *
 * ## 평문은 저장하지 않는다
 * DB 엔 sha256 과 접두(`stepd_live_ab12`)만 둔다. 평문은 발급 응답에 딱 한 번 나가고 끝이다.
 * 저장하면 DB 유출이 곧 남의 채널에 영상을 올릴 수 있는 권한이 된다.
 *
 * ## 라우트는 화이트리스트다
 * 서버 라우트는 118개인데 그건 **세션을 가진 운영자**를 전제로 만든 것이다. 키에 전부 열면
 * 고객사가 남의 결제·관리 라우트까지 두드릴 수 있게 된다. 여기 표에 **명시적으로 올린 것만**
 * 열고, 나머지는 전부 거부한다 — 새 라우트가 생겨도 기본값이 "닫힘"이다.
 */
import crypto from "node:crypto";

export const KEY_PREFIX_LIVE = "stepd_live_";
export const KEY_PREFIX_TEST = "stepd_test_";

/** 표시·조회용 접두 길이 — `stepd_live_` (11) + 4자. billing.ts apiKeyPrefix 와 같은 길이다. */
export const PREFIX_LEN = 15;

/**
 * `billing:write` — 고객사 화면에서 **결제 수단을 등록**하기 위한 스코프 (2026-08-20 사용자 확정).
 *
 * 별도 스코프로 뗀 이유: 표준 고객사 키에서 이것만 빼면 "화면은 보여주되 카드는 못 건드린다"가
 * 성립한다. 기본 6종에는 넣지 않는다 — 필요한 워크스페이스에만 발급 시 체크한다.
 *
 * ⚠️ 이 스코프로도 **다음은 열지 않는다**. 계속 세션 전용이다:
 *   - `POST /api/credits/topup*`   임의 금액을 **즉시** 카드에서 긁는다 (상한이 없다)
 *   - `DELETE /api/billing/card`   결제 수단 제거 = 라인 정지(사보타주)
 *
 * `PUT /api/credits/auto-topup` 은 2026-08-21 에 **열었다**(사용자 요구: 카드를 등록해 두면
 * 자동추천이 STEP-D 에서 끊기지 않고 돌아야 한다). 즉시 결제와 달리 이 경로는 **자기 상한을
 * 스스로 들고 있다**: 임계·충전량·일일 횟수·월 금액에 더해 절대 상한(AUTO_TOPUP_HARD_MAX_*)
 * 이 서버에 박혀 있고, 카드가 없으면 켜지지도 않는다. 그래서 유출 시 최악이 "정해진 상한
 * 안에서 크레딧이 충전된다"지 "임의 금액이 빠져나간다"가 아니다.
 */
export const API_SCOPES = [
  "media:write", "media:read", "search:read",
  "factory:write", "factory:read", "billing:read", "billing:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(v: unknown): v is ApiScope {
  return (API_SCOPES as readonly string[]).includes(String(v));
}

/**
 * 모르는 스코프는 **버린다**(에러가 아니라 무시). 오타 하나로 발급 자체가 실패하면
 * 운영자가 스코프를 아예 안 주는 쪽으로 도망가는데, 그게 더 위험하다.
 * 결과가 비면 호출자가 판단한다 — 스코프 없는 키는 아무것도 못 한다.
 */
export function normalizeScopes(input: unknown): ApiScope[] {
  const arr = Array.isArray(input) ? input : String(input ?? "").split(/[,\s]+/);
  const out: ApiScope[] = [];
  for (const v of arr) {
    const s = String(v).trim();
    if (isApiScope(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 평문 키. `random` 을 인자로 받아 난수 없이 테스트할 수 있게 한다. */
export function formatKey(random: string, live = true): string {
  return `${live ? KEY_PREFIX_LIVE : KEY_PREFIX_TEST}${random}`;
}

export function generateKey(live = true): string {
  return formatKey(crypto.randomBytes(24).toString("base64url"), live);
}

/** 조회 키. 평문을 저장하지 않으므로 **이 해시가 유일한 대조 수단**이다. */
export function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function keyPrefix(raw: string): string {
  return raw.slice(0, PREFIX_LEN);
}

/** 우리 키 형태인가. 아니면 조회조차 하지 않는다(엉뚱한 Bearer 로 DB 를 두드리지 않게). */
export function looksLikeApiKey(raw: string): boolean {
  const s = String(raw ?? "");
  if (!s.startsWith(KEY_PREFIX_LIVE) && !s.startsWith(KEY_PREFIX_TEST)) return false;
  return s.length >= PREFIX_LEN + 8 && s.length <= 200;
}

/** `Authorization: Bearer <key>` 에서 키만. 형식이 아니면 null. */
export function bearerKey(header: string | undefined | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? "").trim());
  if (!m) return null;
  return looksLikeApiKey(m[1]) ? m[1] : null;
}

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  scopes: string[];
  revokedAt: Date | string | null;
  /** 소속 회사 상태 — 정지된 회사의 키는 죽어야 한다(0단계와 같은 규칙). */
  tenantStatus: string | null;
}

/**
 * 이 키를 받아줘도 되는가. 막아야 하면 사유, 아니면 null.
 * **모르면 막는다** — 행이 없거나 상태가 낯설면 통과시키지 않는다.
 */
export function keyBlockReason(row: ApiKeyRow | null | undefined): string | null {
  if (!row) return "알 수 없는 API 키입니다.";
  if (row.revokedAt) return "폐기된 API 키입니다.";
  // 회사 정지가 세션만 끊고 키는 살려 두면, 정지된 회사가 API 로 계속 쓴다.
  if (row.tenantStatus !== "active") return "워크스페이스가 정지되었습니다.";
  if (!Array.isArray(row.scopes) || row.scopes.length === 0) {
    return "이 키에 허용된 권한이 없습니다.";
  }
  return null;
}

// ── 라우트 화이트리스트 ────────────────────────────────────────────────────────

interface RouteRule {
  method: string;
  /** 경로 정규식. `:id` 자리는 `[^/]+` 로 둔다. */
  path: RegExp;
  scope: ApiScope;
}

/**
 * 키로 부를 수 있는 라우트. **여기 없는 건 전부 막힌다.**
 *
 * 고르는 기준은 "고객사가 자기 영상을 넣고, 결과를 가져가는 데 필요한 최소"다.
 * 결제·관리·채널 연결처럼 **사람이 판단해야 하는 것**은 열지 않는다 — 그건 화면에서 한다.
 */
export const API_KEY_ROUTES: RouteRule[] = [
  // 넣기
  { method: "POST", path: /^\/api\/media\/upload-init$/, scope: "media:write" },
  { method: "POST", path: /^\/api\/media\/finalize$/, scope: "media:write" },
  { method: "POST", path: /^\/api\/media\/[^/]+\/analyze$/, scope: "media:write" },
  // 가져가기
  { method: "GET", path: /^\/api\/media\/[^/]+\/analysis$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/transcript$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/stream-url$/, scope: "media:read" },
  // 파생 컨텐츠 — 추천·클립·에셋. 에셋은 서명 URL 대신 키 인증 GET 로 연다:
  // 라우트가 이미 RLS 경로를 지나고, 브라우저 노출은 붙이는 쪽 서버가 프록시한다.
  { method: "GET", path: /^\/api\/media\/[^/]+\/shorts$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/clips$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/thumb$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/frame$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/segment$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/analysis\/frames\/[^/]+$/, scope: "media:read" },
  { method: "GET", path: /^\/api\/media\/[^/]+\/thumbnails$/, scope: "media:read" },
  // 찾기
  { method: "GET", path: /^\/api\/search$/, scope: "search:read" },
  // 공장 — 소스 하나로 분석→쇼츠→배포 완주 (구 x-factory-key 를 대체한다)
  { method: "POST", path: /^\/api\/factory\/videos$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/factory\/ingest$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/factory\/channels$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/factory\/channels\/connect-url$/, scope: "factory:write" },
  { method: "GET", path: /^\/api\/factory\/targets$/, scope: "factory:read" },
  // 목록 — 없으면 고객사는 **자기가 넣은 jobId 를 스스로 보관할 때만** 상태를 볼 수 있다.
  // 사람이 우리 웹에서 돌린 회차가 고객사 화면에 영영 안 나타나던 구멍(스모크 미해결 #3).
  { method: "GET", path: /^\/api\/factory\/jobs$/, scope: "factory:read" },
  { method: "GET", path: /^\/api\/factory\/jobs\/[^/]+$/, scope: "factory:read" },
  // 재시도 — 없으면 일시적 실패 하나가 그 회차를 영구 사망시킨다(사람이 DB 를 만져야 했다).
  // 쓰기 스코프를 요구한다: 다시 태우는 것은 읽기가 아니다.
  { method: "POST", path: /^\/api\/factory\/jobs\/[^/]+\/retry$/, scope: "factory:write" },
  { method: "GET", path: /^\/api\/factory\/jobs\/[^/]+\/performance$/, scope: "factory:read" },
  // 잔액·사용내역 (읽기만 — 결제·카드는 세션 전용으로 남긴다)
  { method: "GET", path: /^\/api\/credits$/, scope: "billing:read" },
  { method: "GET", path: /^\/api\/credits\/invoices$/, scope: "billing:read" },

  // ── 콘솔을 통째로 대신하는 클라이언트용 (2026-08-20) ────────────────────────
  // 고객사(ENA)가 자기 화면을 자기 도메인에서 그린다. 그 화면이 필요로 하는 것을 연다.
  // **여전히 자기 워크스페이스 안이다** — RLS 가 스코프하므로 남의 데이터는 나가지 않는다.

  // 워크스페이스 상태 — 프로그램·회차·추천·클립·미디어 목록의 **유일한 출처**다
  // (개별 목록 라우트가 없다. 우리 웹 store.tsx 도 이걸 쓴다).
  { method: "GET", path: /^\/api\/state$/, scope: "media:read" },

  // 프로그램 — 자동화 라인에 올릴 프로그램을 고객사가 직접 등록·수정한다
  { method: "GET", path: /^\/api\/programs\/[^/]+$/, scope: "media:read" },
  { method: "POST", path: /^\/api\/programs$/, scope: "media:write" },
  { method: "PATCH", path: /^\/api\/programs\/[^/]+$/, scope: "media:write" },

  // 자동배포 규칙 — 발행 계획 화면의 실체
  { method: "GET", path: /^\/api\/automation$/, scope: "factory:read" },
  { method: "POST", path: /^\/api\/automation\/rules$/, scope: "factory:write" },
  { method: "DELETE", path: /^\/api\/automation\/rules\/[^/]+$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/automation\/pause$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/automation\/holds\/release$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/automation\/run$/, scope: "factory:write" },
  { method: "GET", path: /^\/api\/channel-rules$/, scope: "factory:read" },

  // 검수 — 추천 채택·거절·썸네일 선택, 클립 메타데이터 손질
  { method: "POST", path: /^\/api\/recommendations\/[^/]+\/adopt$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/recommendations\/[^/]+\/reject$/, scope: "factory:write" },
  { method: "PATCH", path: /^\/api\/recommendations\/[^/]+\/thumbnail$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/clips\/[^/]+\/generate-metadata$/, scope: "factory:write" },
  { method: "POST", path: /^\/api\/clips\/[^/]+\/regenerate-titles$/, scope: "factory:write" },
  { method: "PATCH", path: /^\/api\/clips\/[^/]+\/metadata\/[^/]+$/, scope: "factory:write" },

  // 결제 수단 **등록만** (2026-08-20). 카드번호는 브라우저 → 포트원으로 직행하고 우리는
  // 빌링키만 받는다. 아래 셋 외의 결제 경로는 전부 세션 전용으로 남는다 —
  // 제거(DELETE)·충전(topup)·자동충전 한도(auto-topup)는 여기 없다. 의도적이다.
  { method: "POST", path: /^\/api\/billing\/card\/prepare$/, scope: "billing:write" },
  { method: "POST", path: /^\/api\/billing\/card$/, scope: "billing:write" },
  { method: "GET", path: /^\/api\/billing\/card$/, scope: "billing:read" },
  // 자동 충전 — 카드를 등록해 두면 잔액이 말라 라인이 서지 않게 한다(2026-08-21).
  // 상한은 서버가 들고 있고(AUTO_TOPUP_HARD_MAX_*) 카드가 없으면 켜지지 않는다.
  { method: "GET", path: /^\/api\/credits\/auto-topup$/, scope: "billing:read" },
  { method: "PUT", path: /^\/api\/credits\/auto-topup$/, scope: "billing:write" },
];

export type RouteVerdict = { ok: true; scope: ApiScope } | { ok: false; reason: string };

/**
 * 이 키로 이 요청을 할 수 있는가.
 *
 * 두 가지를 **다르게** 답한다: 열려 있지 않은 라우트인지, 열려 있는데 권한이 없는지.
 * 뭉뚱그리면 고객사가 "우리 키가 잘못됐나" 와 "그 기능은 API 에 없나" 를 구분 못 한다.
 */
export function checkRoute(method: string, path: string, scopes: string[]): RouteVerdict {
  const m = String(method ?? "").toUpperCase();
  // 쿼리스트링은 떼고 본다 — `/api/search?q=…` 가 `/api/search` 로 읽혀야 한다.
  const p = String(path ?? "").split("?")[0];
  const rule = API_KEY_ROUTES.find((r) => r.method === m && r.path.test(p));
  if (!rule) return { ok: false, reason: `API 키로 호출할 수 없는 경로입니다: ${m} ${p}` };
  if (!scopes.includes(rule.scope)) {
    return { ok: false, reason: `이 키에 ${rule.scope} 권한이 없습니다.` };
  }
  return { ok: true, scope: rule.scope };
}

/**
 * `last_used_at` 을 지금 써야 하는가. 매 요청 UPDATE 는 요청마다 쓰기를 만든다 —
 * "안 쓰는 키를 회수"하는 용도라 분 단위면 충분하다(resolveSession 의 last_seen_at 과 같은 판단).
 */
export const LAST_USED_THROTTLE_MS = 60_000;

export function shouldTouchLastUsed(lastUsedAt: Date | string | null, now: number): boolean {
  if (!lastUsedAt) return true;
  const t = lastUsedAt instanceof Date ? lastUsedAt.getTime() : Date.parse(String(lastUsedAt));
  if (!Number.isFinite(t)) return true;
  return now - t > LAST_USED_THROTTLE_MS;
}
