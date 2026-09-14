/** 카드 원문은 발급 요청 동안만 사용한다. 검증 오류에는 입력값을 넣지 않는다. */
export interface CardCredential {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  birthOrBusinessRegistrationNumber?: string;
  passwordTwoDigits?: string;
}

export function checkCardCredential(input: unknown, now = new Date()):
  | { ok: true; credential: CardCredential }
  | { ok: false; message: string } {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const read = (key: string) => typeof value[key] === "string" ? value[key].trim() : "";
  const number = read("number").replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(number)) return { ok: false, message: "카드번호를 확인해 주세요." };
  const expiryMonth = read("expiryMonth");
  const expiryYear = read("expiryYear");
  if (!/^(0[1-9]|1[0-2])$/.test(expiryMonth) || !/^\d{2}$/.test(expiryYear)) {
    return { ok: false, message: "유효기간을 월 2자리, 연도 2자리로 입력해 주세요." };
  }
  // 월말까지 유효하다. 서버 시간대와 무관하게 한국의 현재 월로 비교한다.
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if ((2000 + Number(expiryYear)) * 12 + Number(expiryMonth)
      < kst.getUTCFullYear() * 12 + kst.getUTCMonth() + 1) {
    return { ok: false, message: "유효기간이 지난 카드입니다." };
  }
  const identity = read("birthOrBusinessRegistrationNumber").replace(/-/g, "");
  if (identity && !/^(\d{6}|\d{10})$/.test(identity)) {
    return { ok: false, message: "생년월일 6자리 또는 사업자등록번호 10자리를 입력해 주세요." };
  }
  const password = read("passwordTwoDigits");
  if (password && !/^\d{2}$/.test(password)) {
    return { ok: false, message: "카드 비밀번호는 앞 2자리만 입력해 주세요." };
  }
  // 임의 요청 필드(CVC·전체 비밀번호 등)는 PG에도 전달하지 않는다.
  return { ok: true, credential: {
    number, expiryMonth, expiryYear,
    ...(identity ? { birthOrBusinessRegistrationNumber: identity } : {}),
    ...(password ? { passwordTwoDigits: password } : {}),
  } };
}
