import { ScreenStub } from "@/components/shell/screen-stub";

/**
 * 영상 분석 — 재설계 화면 (README §). 셸·라우팅만 세운 상태이고 본문은 U5 에서 채운다.
 * 빈 화면을 그냥 두면 "서버 미연결"과 구분이 안 되므로, 무엇이 올 자리인지 명시한다.
 */
export default function Page() {
  return <ScreenStub title="영상 분석" plan="회차 레일 · 원본 플레이어 · 추천 구간(권리/심의 레인) · 채택/보류" pr="U5" />;
}
