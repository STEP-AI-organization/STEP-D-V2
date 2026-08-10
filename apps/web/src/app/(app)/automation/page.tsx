import { ScreenStub } from "@/components/shell/screen-stub";

/**
 * 자동 배포 — 재설계 화면 (README §). 셸·라우팅만 세운 상태이고 본문은 U12 에서 채운다.
 * 빈 화면을 그냥 두면 "서버 미연결"과 구분이 안 되므로, 무엇이 올 자리인지 명시한다.
 */
export default function Page() {
  return <ScreenStub title="자동 배포" plan="5단계 카드 · 규칙 리스트 · 자동 실행 로그(수동과 분리)" pr="U12" />;
}
