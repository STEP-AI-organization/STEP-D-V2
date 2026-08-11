"use client";

/**
 * 로그인 관문.
 *
 * 서버가 인증을 요구하는데(`authRequired`) 세션이 없으면 로그인으로 보낸다.
 *
 * **화면 보호일 뿐이다.** 진짜 방어는 서버에 있다 — 데이터는 테넌트 RLS 가, 배포는
 * publish-dispatch 가 막는다. 이 컴포넌트를 지워도 남의 데이터가 나오지는 않는다.
 * 여기서 하는 일은 "빈 화면을 보고 고장인 줄 아는 것"을 막는 것이다.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useSession } from "@/lib/auth";

export function AuthGuard({ children }: { children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const needsLogin = !session.loading && session.authRequired && !session.user.email;

  useEffect(() => {
    if (!needsLogin) return;
    // 돌아올 곳을 들고 간다 — 로그인 후 대시보드로만 보내면 하던 일을 다시 찾아가야 한다.
    router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [needsLogin, pathname, router]);

  // 판정 전에는 아무것도 그리지 않는다. 잠깐 보였다 사라지는 화면이 더 헷갈린다.
  if (session.loading || needsLogin) {
    return (
      <div className="grid min-h-screen place-items-center" style={{ background: "var(--sd-app-bg)" }}>
        <span className="text-[12px]" style={{ color: "var(--sd-mut)" }}>
          {session.loading ? "확인 중…" : "로그인 화면으로 이동합니다…"}
        </span>
      </div>
    );
  }

  return <>{children}</>;
}
