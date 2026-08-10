import { ScreenStub } from "@/components/shell/screen-stub";

/**
 * 썸네일 생성 — 재설계 화면 (README §). 셸·라우팅만 세운 상태이고 본문은 U11 에서 채운다.
 * 빈 화면을 그냥 두면 "서버 미연결"과 구분이 안 되므로, 무엇이 올 자리인지 명시한다.
 */
export default function Page() {
  return <ScreenStub title="썸네일 생성" plan="대상 라디오(숏폼 제외) · 프롬프트 · 3안 → 대표 지정" pr="U11" />;
}
