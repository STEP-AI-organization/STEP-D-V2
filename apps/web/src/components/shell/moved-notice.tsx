"use client";

/**
 * 옮겨진 화면 안내.
 *
 * 재설계로 화면이 통합될 때 **말없이 리다이렉트하지 않는다.** 쓰던 사람에게는 화면이
 * 사라진 것으로 보이고, 북마크나 문서에 남은 링크가 왜 다른 데로 가는지 알 수 없다.
 * 어디로 갔는지, 왜 갔는지 말하고 보낸다.
 */
import Link from "next/link";

export function MovedNotice({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <div className="sd-card mx-auto max-w-[560px] p-6">
      <div className="sd-eb mb-2" style={{ color: "var(--sd-label)" }}>화면 이동</div>
      <h2 className="sd-serif mb-2 text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
        {title}
      </h2>
      <p className="mb-4 text-[12.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>{body}</p>
      <Link href={href} className="sd-btn sd-btn-primary">바로 가기</Link>
    </div>
  );
}
