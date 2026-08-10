import { ScreenStub } from "@/components/shell/screen-stub";

/**
 * 대시보드 — 재설계 화면 (README §1). 셸·라우팅만 세운 상태이고 본문은 U13 에서 채운다.
 * 수익은 권한이 없으면 0 이 아니라 '비공개' 로 내려야 한다 (FLOWS.md:169).
 */
export default function Page() {
  return (
    <ScreenStub
      title="대시보드"
      plan={"F3 게이트 요약 · 수익(권한 없으면 ‘비공개’) · 채널 순위 · 최근 배포"}
      pr="U13"
    />
  );
}
