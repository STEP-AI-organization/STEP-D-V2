import { ScreenStub } from "@/components/shell/screen-stub";

/**
 * 채널 분석 — 재설계 화면 (README §). 셸·라우팅만 세운 상태이고 본문은 U14 에서 채운다.
 * 빈 화면을 그냥 두면 "서버 미연결"과 구분이 안 되므로, 무엇이 올 자리인지 명시한다.
 */
export default function Page() {
  return <ScreenStub title="채널 분석" plan="채널 단위 성과" pr="U14" />;
}
