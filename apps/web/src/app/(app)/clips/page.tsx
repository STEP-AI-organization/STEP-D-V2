import { MovedNotice } from "@/components/shell/moved-notice";

/**
 * 옛 클립 화면 자리. **바로 리다이렉트하지 않는다** — 쓰던 사람에게는 화면이 말없이
 * 사라진 것으로 보이고, 북마크·문서에 남은 링크가 왜 다른 곳으로 가는지 알 수 없다.
 * 어디로 갔는지 말하고 보낸다.
 */
export default function Page() {
  return (
    <MovedNotice
      title="클립 화면이 옮겨졌습니다"
      body="클립·숏폼이 **미디어** 한 곳으로 합쳐졌습니다. 권리·심의 게이트가 거기 붙어 있어, 배포는 미디어 화면에서 합니다."
      href="/media"
    />
  );
}
