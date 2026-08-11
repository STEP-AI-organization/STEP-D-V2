"use client";

/**
 * 사이드바 (README §0).
 *
 * 확정 수치를 그대로 지킨다 — width 206px · 배경 #f6f7fa · 우측 보더 #e2e5ee ·
 * padding 14px 10px · 항목 7px 10px / radius 4px / 12.5px · 활성 #1f4fd8 배경에 흰 글씨.
 * 하단에 연결 상태(7px 녹색 점 + 8초 폴링).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useSession } from "@/lib/auth";
import { logout } from "@/lib/data/api";
import { NAV_GROUPS } from "@/lib/nav";
import { roleOf } from "@/lib/roles";
import { cn } from "@/lib/utils";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/proxy/api";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 flex w-[206px] flex-col border-r"
      style={{ background: "var(--sd-sidebar-bg)", borderColor: "var(--sd-sidebar-border)", padding: "14px 10px" }}
    >
      <Link href="/dashboard" className="mb-3 flex items-center gap-2 px-2">
        <span
          className="grid size-[18px] place-items-center rounded-[4px] text-[11px] font-bold text-white"
          style={{ background: "var(--sd-accent)" }}
          aria-hidden
        >
          D
        </span>
        <span className="sd-serif text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          STEP-D
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label ?? `g${gi}`} className={gi > 0 ? "mt-4" : undefined}>
            {group.label && (
              <div className="sd-eb px-2 pb-1.5" style={{ color: "var(--sd-label)" }}>
                {group.label}
              </div>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn("sd-nav-item", active && "sd-nav-item--active")}
                    >
                      <Icon className="size-[13px] shrink-0" aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <CurrentUser />
      <ConnectionStatus />
    </aside>
  );
}

/**
 * 현재 사용자 — 이름과 **운영 역할**을 보여준다.
 *
 * 역할을 안 보여주면 "왜 배포 버튼이 없지"에서 막힌다. 워크스페이스 역할이 아니라
 * 방송 업무 역할을 띄우는 게 맞다 — 화면의 권한이 그걸로 정해지기 때문이다.
 */
function CurrentUser() {
  const session = useSession();
  const router = useRouter();
  if (!session.user.email) return null;

  return (
    <div className="mt-3 flex items-center gap-1.5 px-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px]" style={{ color: "var(--sd-fg)" }}>{session.user.name}</div>
        <div className="truncate text-[10px]" style={{ color: "var(--sd-mut)" }}>
          {roleOf(session.user.role).label}
        </div>
      </div>
      <button
        type="button"
        className="shrink-0 text-[10.5px] underline-offset-2 hover:underline"
        style={{ color: "var(--sd-mut)" }}
        onClick={async () => {
          await logout();
          router.replace("/login");
          router.refresh();
        }}
      >
        로그아웃
      </button>
    </div>
  );
}

/**
 * 연결 상태 — 8초 폴링 (FLOWS.md:190).
 * 끊긴 걸 조용히 두지 않는다. 빈 화면이 "데이터 없음"인지 "서버 미연결"인지
 * 여기서 구분된다.
 */
function ConnectionStatus() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const res = await fetch(`${API_BASE}/state`, { cache: "no-store" });
        if (alive) setOk(res.ok);
      } catch {
        if (alive) setOk(false);
      }
    };
    void ping();
    const t = setInterval(ping, 8000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const label = ok === null ? "연결 확인 중…" : ok ? "서버 연결됨 · 8초 폴링" : "서버 미연결";
  const color = ok === null ? "var(--sd-idle)" : ok ? "var(--sd-ok)" : "var(--sd-danger)";

  return (
    <div className="mt-3 flex items-center gap-1.5 px-2 pt-2" style={{ borderTop: "1px solid var(--sd-sidebar-border)" }}>
      <span className="size-[7px] shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <span className="truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{label}</span>
    </div>
  );
}
