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

/** `t_` + 소문자·숫자·밑줄. 경로에도 SQL 에도 실리는 값이라 좁게 잡는다. */
export const TENANT_ID_RE = /^t_[a-z0-9_]{1,40}$/;

/**
 * 신규 회사에 얹을 수 있는 무상 크레딧 상한. 1 크레딧 = 분석 1분이라
 * 100,000 이면 약 1,667시간 — 손이 미끄러져도 회사 하나가 그 이상 공짜로 받지는 않게 한다.
 */
export const MAX_INITIAL_CREDITS = 100_000;

/**
 * 회사 이름 → 테넌트 id.
 *
 * ⚠️ **한글 이름을 반드시 처리해야 한다.** 예전 코드는
 * `t_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0,20)}` 였는데,
 * 한글은 `[^a-z0-9]` 에 전부 걸려서 "한국방송"·"문화방송"·"스텝에이아이"가 **모두 `t__`** 가
 * 됐다. 형식 검사(`t__` 는 통과한다)도 못 잡아서, 첫 회사만 만들어지고 **두 번째 한글 회사부터
 * 전부 `duplicate_id` 409** 였다. 방송사 이름은 대개 한글이라 사실상 못 쓰는 상태였다.
 *
 * 슬러그가 비면 `nonce` 로 대체한다. nonce 를 인자로 받는 이유는 이 함수를 난수 없이
 * 테스트하기 위해서다.
 */
export function deriveTenantId(name: string, nonce: string): string {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20)
    .replace(/_+$/g, "");
  return slug ? `t_${slug}` : `t_${nonce}`;
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
  id: string;
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
  nonce: string,
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

  const id = String(input.id ?? "").trim() || deriveTenantId(name, nonce);
  if (!TENANT_ID_RE.test(id)) {
    return {
      ok: false,
      error: "invalid_id",
      message: "id 는 t_ 로 시작하는 소문자·숫자·밑줄이어야 합니다.",
    };
  }

  return {
    ok: true,
    plan: {
      id,
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
