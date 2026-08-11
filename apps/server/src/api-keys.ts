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

export const API_SCOPES = ["media:write", "media:read", "search:read"] as const;
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
  // 찾기
  { method: "GET", path: /^\/api\/search$/, scope: "search:read" },
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
