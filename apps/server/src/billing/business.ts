/**
 * 회사 사업자정보 — 거래명세서의 "공급받는 자"에 들어가는 값. 순수 모듈.
 *
 * ## 왜 tenants 에 안 넣는가
 * `tenants` 는 이제 **세션 검증마다 조인된다**(0단계 · 회사 정지 실효화). 인보이스에서만
 * 쓰는 여섯 칸을 거기 붙이면 매 요청이 조금씩 무거워진다. 1:1 별도 표로 둔다.
 *
 * ## 사업자등록번호는 검증식이 있다
 * 국세청 검증 알고리즘으로 **오타를 잡는다.** 실재 여부까지는 확인 못 하지만, 자리를
 * 하나 잘못 친 건 여기서 걸린다. 문서에 잘못된 번호가 찍혀 나가면 상대가 회계 처리를
 * 못 하고, 그건 다시 만들어 보내야 하는 일이 된다.
 */

/** 숫자만. `123-45-67890` 처럼 하이픈이 섞여 와도 같은 값으로 본다. */
export function normalizeBizNo(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** `1234567890` → `123-45-67890`. 저장은 숫자만, 표시만 하이픈. */
export function formatBizNo(v: unknown): string {
  const d = normalizeBizNo(v);
  if (d.length !== 10) return String(v ?? "");
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/**
 * 사업자등록번호 검증 (국세청 체크섬).
 *
 * 가중치 `[1,3,7,1,3,7,1,3,5]` 를 앞 9자리에 곱해 더하고, 9번째 자리 × 5 의 **십의 자리**를
 * 한 번 더 더한다. `(10 - 합 % 10) % 10` 이 마지막 자리와 같아야 한다.
 *
 * 이 단계를 건너뛰면 `000-00-00000` 같은 값이 그대로 문서에 찍힌다.
 */
export function isValidBizNo(v: unknown): boolean {
  const d = normalizeBizNo(v);
  if (d.length !== 10) return false;
  // ⚠️ `0000000000` 은 **체크섬을 통과한다**(합 0 → 검증자리 0). 사람들이 제일 흔히 넣는
  // 자리표시자라 그대로 두면 그 값이 문서에 찍혀 나간다. 같은 숫자만 반복되는 값을 막는다.
  if (/^(\d)\1{9}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i];
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

export interface BusinessProfile {
  bizName: string;
  bizNo: string;
  ceoName: string;
  address: string;
  bizType: string;
  bizItem: string;
  contactEmail: string;
  contactPhone: string;
}

export const EMPTY_PROFILE: BusinessProfile = {
  bizName: "", bizNo: "", ceoName: "", address: "",
  bizType: "", bizItem: "", contactEmail: "", contactPhone: "",
};

export type ProfileCheck =
  | { ok: true; profile: BusinessProfile }
  | { ok: false; message: string; field: string };

/**
 * 입력 → 저장할 값.
 *
 * **상호와 사업자등록번호만 필수**다. 나머지(대표자·주소·업태·종목)는 거래명세서에
 * 있으면 좋지만 없다고 문서가 못 나가는 건 아니다 — 다 필수로 걸면 운영자가 아무것도
 * 못 채우고 포기한다. 대신 비어 있으면 화면이 "덜 채워졌다"고 알려준다.
 */
export function checkProfile(input: Record<string, unknown>): ProfileCheck {
  const bizName = String(input.bizName ?? "").trim();
  if (!bizName) return { ok: false, field: "bizName", message: "상호(법인명)를 입력하세요." };
  if (bizName.length > 120) return { ok: false, field: "bizName", message: "상호가 너무 깁니다." };

  const bizNo = normalizeBizNo(input.bizNo);
  if (!bizNo) return { ok: false, field: "bizNo", message: "사업자등록번호를 입력하세요." };
  if (bizNo.length !== 10) {
    return { ok: false, field: "bizNo", message: "사업자등록번호는 10자리입니다." };
  }
  if (!isValidBizNo(bizNo)) {
    // "형식이 틀렸다"가 아니라 "검증에 걸렸다"고 말한다 — 자릿수는 맞는데 틀린 경우다.
    return {
      ok: false,
      field: "bizNo",
      message: `사업자등록번호 검증에 실패했습니다 (${formatBizNo(bizNo)}). 자리를 다시 확인해 주세요.`,
    };
  }

  const email = String(input.contactEmail ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) {
    return { ok: false, field: "contactEmail", message: `이메일 형식이 아닙니다: ${email}` };
  }

  const trim = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
  return {
    ok: true,
    profile: {
      bizName,
      bizNo,
      ceoName: trim(input.ceoName, 60),
      address: trim(input.address, 300),
      bizType: trim(input.bizType, 60),
      bizItem: trim(input.bizItem, 60),
      contactEmail: email,
      contactPhone: String(input.contactPhone ?? "").replace(/[^\d+\-() ]/g, "").trim().slice(0, 40),
    },
  };
}

/**
 * 거래명세서로 내보내기에 **덜 채워진 항목**. 막지는 않고 알려만 준다.
 * 세금계산서를 붙일 때는 이 항목들이 전부 필수가 된다.
 */
export function incompleteFields(p: BusinessProfile | null): string[] {
  if (!p) return ["상호", "사업자등록번호", "대표자", "주소", "업태", "종목"];
  const out: string[] = [];
  if (!p.bizName) out.push("상호");
  if (!p.bizNo) out.push("사업자등록번호");
  if (!p.ceoName) out.push("대표자");
  if (!p.address) out.push("주소");
  if (!p.bizType) out.push("업태");
  if (!p.bizItem) out.push("종목");
  return out;
}
