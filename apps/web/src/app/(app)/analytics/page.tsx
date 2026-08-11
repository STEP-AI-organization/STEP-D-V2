import { MovedNotice } from "@/components/shell/moved-notice";

/**
 * 옛 성과 화면 자리. **바로 리다이렉트하지 않는다** — 쓰던 사람에게는 화면이 말없이
 * 사라진 것으로 보이고, 북마크·문서에 남은 링크가 왜 다른 곳으로 가는지 알 수 없다.
 * 어디로 갔는지 말하고 보낸다.
 */
export default function Page() {
  return (
    <MovedNotice
      title="성과 화면이 옮겨졌습니다"
      body="성과가 **성과 · 프로그램 분석 · 채널 분석** 셋으로 나뉘었습니다. 채널별 지표는 성과 화면에서 봅니다."
      href="/performance"
    />
  );
}
