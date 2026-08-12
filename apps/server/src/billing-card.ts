/**
 * 회사별 카드 저장(빌링키) — 매번 카드를 다시 넣지 않고 버튼 한 번으로 충전한다.
 *
 * ## 카드 번호는 우리 서버에 오지 않는다
 * 브라우저 SDK(`requestIssueBillingKey`)가 카드 정보를 **포트원으로 직접** 보내고, 우리는
 * 그 결과인 **빌링키 문자열**만 받는다. 그래서 우리 DB 가 털려도 카드 번호는 없다.
 * 대신 빌링키 자체가 "이 카드로 긁을 수 있는 권한"이라, 이걸 쓰는 경로는
 * 회사 스코프(RLS) 안에서만 돌아야 한다.
 *
 * ## 채널이 일반결제와 다르다
 * 포트원은 일반결제와 빌링이 **별도 채널**이다. `PORTONE_CHANNEL_KEY`(일반결제)로
 * 빌링키를 발급하려 들면 실패한다. 그래서 `PORTONE_BILLING_CHANNEL_KEY` 를 따로 읽고,
 * **없으면 카드 등록 자체를 열지 않는다** — 실패 방향이 "등록 안 됨"이어야지
 * "엉뚱한 채널로 시도했다가 알 수 없는 오류"가 되면 안 된다.
 *
 * ## KG이니시스 필수 입력 (PC)
 * 문서상 `fullName`(또는 first+last) · `phoneNumber` · `email` 이 **전부 필수**다.
 * 일반결제에서 이 셋을 하나씩 빠뜨려 세 번 연속 실패한 적이 있다(2026-08-11).
 * 그래서 여기서 **미리 셋 다 확인하고**, 없으면 결제창을 띄우지 않는다.
 */

export interface BillingConfig {
  storeId: string;
  channelKey: string;
}

export type BillingConfigCheck =
  | { ok: true; config: BillingConfig }
  | { ok: false; missing: string[]; message: string };

/**
 * 빌링(카드 저장) 설정이 갖춰졌는가. 일반결제와 **다른 채널키**를 본다.
 * 하나라도 비면 카드 등록 경로를 열지 않는다.
 */
export function billingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfigCheck {
  const storeId = String(env.PORTONE_STORE_ID ?? "").trim();
  const channelKey = String(env.PORTONE_BILLING_CHANNEL_KEY ?? "").trim();
  const missing: string[] = [];
  if (!storeId) missing.push("PORTONE_STORE_ID");
  if (!channelKey) missing.push("PORTONE_BILLING_CHANNEL_KEY");
  if (missing.length) {
    return {
      ok: false,
      missing,
      message:
        `카드 등록 설정이 없습니다: ${missing.join(", ")}. ` +
        "빌링은 일반결제와 **다른 채널**이라 채널키가 따로 필요합니다.",
    };
  }
  return { ok: true, config: { storeId, channelKey } };
}

export interface CustomerInfo {
  fullName: string;
  email: string;
  phoneNumber: string;
}

export type CustomerCheck =
  | { ok: true; customer: CustomerInfo }
  | { ok: false; missing: string[]; message: string };

/** 숫자만 남긴다. `010-1234-5678` 처럼 오는 걸 그대로 보내면 PG 가 거절한다. */
export function normalizePhone(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/**
 * KG이니시스 PC 빌링키 발급에 필요한 고객 정보를 **미리** 검사한다.
 * 셋 중 하나라도 없으면 결제창을 띄우지 않는다 — 띄워 봐야 PG 가 거절하고,
 * 그 오류 문구는 사용자가 뭘 채워야 하는지 알려주지 않는다.
 */
export function checkCustomer(input: {
  fullName?: unknown;
  email?: unknown;
  phoneNumber?: unknown;
}): CustomerCheck {
  const fullName = String(input.fullName ?? "").trim();
  const email = String(input.email ?? "").trim();
  const phoneNumber = normalizePhone(input.phoneNumber);
  const missing: string[] = [];
  if (!fullName) missing.push("이름");
  if (!email || !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) missing.push("이메일");
  // 국내 휴대폰은 10~11자리. 너무 짧으면 오타다.
  if (phoneNumber.length < 10 || phoneNumber.length > 11) missing.push("휴대폰번호");
  if (missing.length) {
    return {
      ok: false,
      missing,
      message: `카드 등록에 ${missing.join(" · ")}가 필요합니다 (KG이니시스 필수 입력).`,
    };
  }
  return { ok: true, customer: { fullName, email, phoneNumber } };
}

/**
 * 빌링키 발급 요청 식별자. 포트원이 요구하는 `issueId` 다.
 * 회사 + nonce 로 만들어 **재시도해도 같은 회사 것임이 드러나게** 한다.
 */
export function issueIdFor(tenantId: string, nonce: string): string {
  return `bk_${tenantId}_${nonce}`;
}

/**
 * 저장된 카드로 긁을 때의 결제 id. **멱등키**다 —
 * 같은 값으로 두 번 부르면 포트원이 중복 결제를 막는다(portone.ts 참조).
 * 그래서 매번 새로 만들되, 재시도 시에는 **같은 값을 다시 써야** 보호가 산다.
 */
export function cardTopupPaymentId(tenantId: string, nonce: string): string {
  return `card_${tenantId}_${nonce}`;
}

/**
 * 빌링키 조회 응답(getBillingKeyInfo)에서 **표시용** 카드 정보를 뽑는다.
 *
 * 순수 함수 — 포트원 응답 모양이 버전·PG 마다 조금씩 달라서, 알려진 경로들을 방어적으로
 * 훑고 **못 찾으면 조용히 null** 을 준다(카드는 이미 저장됐고 표시만 못 할 뿐이라 치명적이지 않다).
 * 마스킹된 번호는 보통 `533274******1234` 처럼 **끝 4자리가 보인다** — 맨 뒤 숫자 묶음을 쓴다.
 */
export function extractCardDisplay(info: unknown): { brand: string | null; last4: string | null } {
  const root = info as Record<string, any> | null;
  const card =
    (Array.isArray(root?.methods) ? root!.methods.find((m: any) => m?.card)?.card : null) ??
    root?.method?.card ??
    root?.card ??
    null;
  if (!card || typeof card !== "object") return { brand: null, last4: null };

  // 발급사(신한카드 등)가 브랜드 enum(MASTER 등)보다 사람에게 낫다 — 있는 걸 우선.
  const brandRaw = card.issuer ?? card.name ?? card.publisher ?? card.brand ?? null;
  const brand = typeof brandRaw === "string" && brandRaw.trim() ? brandRaw.trim().slice(0, 40) : null;

  const num = typeof card.number === "string" ? card.number : "";
  // 맨 뒤 숫자 묶음(마스킹 뒤 보이는 끝자리). 없으면 전체 숫자의 끝 4자리로 폴백.
  const tail = num.match(/(\d+)(?!.*\d)/);
  const digits = num.replace(/\D/g, "");
  const last4 = tail ? tail[1].slice(-4) : digits.length >= 4 ? digits.slice(-4) : null;
  return { brand, last4 };
}

/** 화면 표시용. 카드 번호는 애초에 없고 브랜드·끝 4자리만 포트원이 준다. */
export function cardLabel(brand: string | null, last4: string | null): string {
  const b = String(brand ?? "").trim();
  const l = String(last4 ?? "").trim();
  if (!b && !l) return "등록된 카드";
  if (!l) return b;
  return `${b || "카드"} ****${l}`;
}

export interface StoredCard {
  /** 해지하면 비운다(0029) — 그래서 null 이 정상 상태 중 하나다. */
  billingKey: string | null;
  revokedAt: Date | string | null;
}

/**
 * 이 카드로 결제해도 되는가. 막아야 하면 사유, 아니면 null.
 * **모르면 막는다** — 카드가 없거나 해지됐는데 긁으려 들면 안 된다.
 */
export function cardBlockReason(card: StoredCard | null | undefined): string | null {
  if (!card || !card.billingKey) return "등록된 카드가 없습니다. 카드를 먼저 등록해 주세요.";
  if (card.revokedAt) return "해지된 카드입니다. 카드를 다시 등록해 주세요.";
  return null;
}

/**
 * 포트원 결제 응답이 우리가 요청한 것과 맞는가.
 *
 * 서버가 직접 부른 결과라 브라우저처럼 위조되진 않지만, **금액이 어긋나면 크레딧을 주면
 * 안 된다.** 부분 승인·통화 오설정 같은 경우가 조용히 지나가면 원장이 결제와 어긋난다.
 */
export function verifyCharge(input: {
  response: unknown;
  expectedKrw: number;
}): { ok: true } | { ok: false; message: string } {
  const r = input.response as { status?: string; amount?: { total?: number } } | null;
  const status = String(r?.status ?? "").toUpperCase();
  if (status && status !== "PAID") {
    return { ok: false, message: `결제가 완료되지 않았습니다 (상태 ${status}).` };
  }
  const total = r?.amount?.total;
  // 금액을 안 돌려주는 응답도 있다 — **있을 때만** 대조한다. 없다고 실패로 보면
  // 실제로 긁힌 결제를 크레딧 없이 버리게 된다(돈만 받고 안 준 꼴).
  if (typeof total === "number" && total !== input.expectedKrw) {
    return { ok: false, message: `결제 금액이 다릅니다 (요청 ${input.expectedKrw} · 승인 ${total}).` };
  }
  return { ok: true };
}
