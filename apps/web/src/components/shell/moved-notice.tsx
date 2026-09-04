"use client";

/**
 * 옮겨진 화면 안내.
 *
 * 재설계로 화면이 통합될 때 **말없이 리다이렉트하지 않는다.** 쓰던 사람에게는 화면이
 * 사라진 것으로 보이고, 북마크나 문서에 남은 링크가 왜 다른 데로 가는지 알 수 없다.
 * 어디로 갔는지, 왜 갔는지 말하고 보낸다.
 */
import Link from "next/link";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";

export function MovedNotice({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <>
      <Header title={title} subtitle="이 화면은 다른 곳으로 합쳐졌습니다" />
      <main className="flex-1 p-6 flex flex-col justify-between overflow-y-auto">
        <div className="bg-[var(--color-bg-card)] border-none rounded-2xl shadow-md shadow-slate-900/5 dark:shadow-none mx-auto max-w-[560px] w-full p-6">
          <div className="text-[11px] font-bold text-[var(--color-text-muted)] mb-2">화면 이동</div>
          <h2 className="font-bold text-base text-[var(--color-text-primary)] mb-2">{title}</h2>
          <p className="mb-4 text-xs leading-relaxed text-[var(--color-text-muted)]">{body}</p>
          <Link
            href={href}
            className="inline-flex px-3.5 py-1.5 rounded-full bg-[var(--color-bg-active)] hover:bg-[#0D1EB8] text-white text-xs font-bold border-none cursor-pointer transition-colors shadow-none"
          >
            바로 가기
          </Link>
        </div>
        <Footer />
      </main>
    </>
  );
}
