import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shell for the public legal pages. Google's OAuth verification requires the
 * privacy policy and terms to be reachable without signing in, so these render
 * outside the app shell and pull no data.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12 border-b border-zinc-800 pb-8">
          {/* App icon must be visible at the top of the legal pages — required by
              the TikTok / Google app review checklists. */}
          {/* "/" 는 대시보드로 리다이렉트돼 AuthGuard 가 로그인으로 튕긴다 — 이 페이지들은
              로그인 없이 도달할 수 있어야 하므로 공개 랜딩으로 보낸다. */}
          <Link href="/landing" className="flex items-center gap-3 text-zinc-400 hover:text-zinc-200 transition">
            <img
              src="/brand/stepd-icon-192.png"
              alt="STEP D 앱 아이콘"
              width={44}
              height={44}
              className="h-11 w-11 rounded-xl border border-zinc-700"
            />
            <span className="text-lg font-bold text-white">STEP D</span>
          </Link>
          <h1 className="mt-5 text-3xl font-bold text-white">{title}</h1>
          <p className="mt-2 text-sm text-zinc-500">최종 수정일: {updated}</p>
        </header>

        <div className="space-y-10 leading-relaxed [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_h2]:mb-3 [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5 [&_li]:text-zinc-400 [&_a]:text-blue-400 [&_a]:underline">
          {children}
        </div>

        <footer className="mt-16 border-t border-zinc-800 pt-8 text-sm text-zinc-500">
          <p>STEP AI · 문의 <a href="mailto:hkj@stepai.kr">hkj@stepai.kr</a></p>
          <p className="mt-2 flex gap-4">
            <Link href="/privacy">개인정보처리방침</Link>
            <Link href="/terms">서비스 이용약관</Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
