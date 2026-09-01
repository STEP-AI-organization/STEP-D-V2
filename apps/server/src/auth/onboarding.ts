/**
 * 회사 온보딩 — 회사 생성 + 첫 owner 초대 + 초기 크레딧을 **한 번에** 정하는 판정부.
 * (다회사 운영 2단계 · docs/plans/admin-multi-tenant-plan.md)
 *
 * ## 왜 한 번에인가
 * 예전엔 회사 만들기(`POST /superadmin/tenants`)와 첫 관리자 초대(`.../invite`)가 따로였다.
 * 두 번째가 실패하면 **아무도 들어갈 수 없는 회사**가 남는다. 회사 목록엔 보이는데 사용자가
 * 0명이라, 운영자는 그게 "아직 초대 안 한 것"인지 "초대가 실패한 것"인지 구분할 수 없다.
 * 그래서 owner 이메일을 **필수**로 받고, 셋을 한 트랜잭션으로 묶는다.
 *
 * 이 파일은 DB 를 모른다 — 값 판정만 한다. 트랜잭션은 라우트가 연다.
 */

export const TENANT_KINDS = ["internal", "web", "api"] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

/**
 * 회사 id — **그냥 순번**이다. `1` · `2` · `3` …
 *
 * 사람에게 의미 있는 건 **이름**이지 id 가 아니다. 예전엔 `t_` + 이름 슬러그로 만들었는데,
 * 한글 이름은 슬러그가 통째로 비어서 `t_a3f9c2b1e0` 같은 난수가 됐다. 그걸 보고 "id 를
 * 읽히게 만들자"로 갔던 게 방향이 틀렸다 — **id 가 로그에 보이는 게 문제면 로그에 이름을
 * 보여주면 된다.** id 는 내부 키로 두고, 화면이 이름을 해석한다(admin 의 tenantName).
 *
 * 그래서 사람이 id 를 정할 일이 없다. 형식 검사는 남긴다 — 기존 `t_default` 와, 혹시
 * 손으로 넣을 값이 URL·SQL 에 안전한지만 본다.
 */
export const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * 쓸 수 없는 id. `*` 는 시스템 스코프 문자열이고(tenant.ts ALL_TENANTS), 나머지는 로그에서
 * "특별한 뜻"으로 읽힐 값들이라 회사 이름으로 쓰면 나중에 반드시 헷갈린다.
 */
export const RESERVED_TENANT_IDS = new Set([
  "all", "any", "none", "null", "system", "default", "admin", "api", "www", "internal",
]);

/**
 * 신규 회사에 얹을 수 있는 무상 크레딧 상한. 1 크레딧 = 분석 1분이라
 * 100,000 이면 약 1,667시간 — 손이 미끄러져도 회사 하나가 그 이상 공짜로 받지는 않게 한다.
 */
export const MAX_INITIAL_CREDITS = 100_000;

/**
 * 다음 회사 id — 지금까지 쓰인 숫자 id 중 가장 큰 값 + 1.
 *
 * 순수 함수라 DB 를 모른다. 호출부가 **같은 트랜잭션 안에서** 현재 목록을 읽어 넘긴다.
 * 두 개가 동시에 만들어져도 PK 가 유일성을 지키므로, 최악이 "409 뜨고 다시 누름"이지
 * "같은 번호가 둘 생김"이 아니다.
 *
 * 숫자가 아닌 기존 id(`t_default`)는 무시한다 — 섞여 있어도 상관없다.
 *
 * ## 왜 이름에서 만들지 않는가
 * 예전엔 `t_${이름 슬러그}` 였는데 한글은 `[^a-z0-9]` 에 전부 걸려서 "한국방송"·"문화방송"이
 * **모두 `t__`** 가 됐고, 두 번째 한글 회사부터 `duplicate_id` 409 였다. 그걸 난수로 때우면
 * (`t_a3f9c2b1e0`) 충돌은 없지만 사람이 못 읽는 값이 영구히 박힌다.
 *
 * **id 를 읽히게 만드는 게 답이 아니다.** id 가 로그에 보이는 게 불편했던 거라면 로그가
 * 이름을 보여주면 된다(admin 의 `tenantName`). id 는 내부 키로 두고 순번만 준다.
 */
export function nextTenantId(existingIds: readonly string[]): string {
  let max = 0;
  for (const id of existingIds) {
    if (/^\d+$/.test(String(id))) max = Math.max(max, Number(id));
  }
  return String(max + 1);
}

/** 모르는 값은 가장 좁은 쪽(api)으로 떨어뜨린다 — internal 은 사내용이라 실수로 붙으면 안 된다. */
export function normalizeKind(kind: unknown): TenantKind {
  return (TENANT_KINDS as readonly string[]).includes(String(kind)) ? (String(kind) as TenantKind) : "api";
}

/** 소수·음수·문자열·NaN 을 0..MAX 정수로 눌러 담는다. */
export function clampInitialCredits(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.trunc(n), MAX_INITIAL_CREDITS);
}

/**
 * 최소한의 이메일 형태 검사. 정규식으로 RFC 를 흉내내지 않는다 — 실제 유효성은 초대 메일이
 * 도착하는지로만 확인된다. 여기서는 **오타로 회사가 잠기는 것**만 막는다.
 */
export function looksLikeEmail(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return s.length >= 5 && s.length <= 254 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(s);
}

export interface OnboardPlan {
  /** 사람이 주지 않으면 null — 라우트가 트랜잭션 안에서 순번을 매긴다. */
  id: string | null;
  name: string;
  kind: TenantKind;
  billingEmail: string | null;
  ownerEmail: string;
  initialCredits: number;
}

export type OnboardCheck =
  | { ok: true; plan: OnboardPlan }
  | { ok: false; error: string; message: string };

/**
 * 입력 → 실행 계획. 실패하면 **무엇이 왜 안 되는지**를 사람 말로 돌려준다.
 * 여기서 걸러지면 DB 를 아예 건드리지 않는다.
 */
export function planOnboarding(
  input: {
    id?: unknown;
    name?: unknown;
    kind?: unknown;
    billingEmail?: unknown;
    ownerEmail?: unknown;
    initialCredits?: unknown;
  },
): OnboardCheck {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "name_required", message: "회사 이름이 필요합니다." };
  if (name.length > 120) return { ok: false, error: "name_too_long", message: "회사 이름이 너무 깁니다." };

  const ownerEmail = String(input.ownerEmail ?? "").trim();
  if (!ownerEmail) {
    return {
      ok: false,
      error: "owner_email_required",
      // 왜 필수인지 같이 말한다 — 안 그러면 "왜 이걸 강제하냐"는 질문이 매번 돈다.
      message: "첫 관리자 이메일이 필요합니다. 들어갈 사람 없이 회사만 만들면 아무도 못 씁니다.",
    };
  }
  if (!looksLikeEmail(ownerEmail)) {
    return { ok: false, error: "invalid_owner_email", message: `이메일 형식이 아닙니다: ${ownerEmail}` };
  }

  const billingEmail = String(input.billingEmail ?? "").trim();
  if (billingEmail && !looksLikeEmail(billingEmail)) {
    return { ok: false, error: "invalid_billing_email", message: `청구 이메일 형식이 아닙니다: ${billingEmail}` };
  }

  // id 는 보통 안 받는다 — 라우트가 순번을 매긴다. 손으로 준 경우에만 형식을 본다
  // (마이그레이션·픽스처용 경로다. 화면에는 입력란이 없다).
  const given = String(input.id ?? "").trim();
  if (given && !TENANT_ID_RE.test(given)) {
    return { ok: false, error: "invalid_id", message: "id 는 소문자·숫자·밑줄·하이픈만 됩니다." };
  }
  if (given && RESERVED_TENANT_IDS.has(given)) {
    return { ok: false, error: "reserved_id", message: `쓸 수 없는 id 입니다: ${given}` };
  }

  return {
    ok: true,
    plan: {
      id: given || null,
      name,
      kind: normalizeKind(input.kind),
      billingEmail: billingEmail || null,
      ownerEmail,
      initialCredits: clampInitialCredits(input.initialCredits),
    },
  };
}

/**
 * 초대 링크. 운영자가 이걸 그대로 복사해 보낸다 — 토큰만 주면 매번 손으로 URL 을 조립해야
 * 하고, 그 과정에서 `?token=` 을 빼먹으면 초대 화면이 "토큰이 없습니다"만 띄운다.
 *
 * publicUrl 이 비면 null. **가짜 링크를 만들지 않는다** — 안 되는 링크를 주는 것보다
 * 토큰만 주는 게 낫다.
 */
export function inviteLink(publicUrl: string | undefined, token: string): string | null {
  const base = String(publicUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/invite?token=${encodeURIComponent(token)}`;
}

/** 초기 크레딧 원장 행의 dedupe 키. 같은 회사에 개설 지급이 두 번 쌓이지 않게. */
export function grantDedupeKey(tenantId: string): string {
  return `grant:onboarding:${tenantId}`;
}
