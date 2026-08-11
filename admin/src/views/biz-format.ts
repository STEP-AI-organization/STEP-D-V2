/** 사업자등록번호 표시용. 저장은 숫자만이고 하이픈은 보여줄 때만 붙인다(서버 business.ts 와 같은 규칙). */
export function formatBizNo(v: string | null | undefined): string {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length !== 10) return String(v ?? "");
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}
