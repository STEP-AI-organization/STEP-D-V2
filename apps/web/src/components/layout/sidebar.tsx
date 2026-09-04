"use client";

/**
 * 사이드바 — 디자이너 산출물 이식 (원본 `STEPD_SaaS_UI_V1/src/components/layout/sidebar.tsx`).
 *
 * **마크업·클래스는 한 글자도 안 바꿨다.** 바꾼 건 목 데이터를 실제 배선으로 되돌린 것뿐이다.
 *
 * | 원본(목업)                     | 이식본 |
 * |---|---|
 * | `SIDEBAR_SECTIONS`(mockData)   | `NAV_GROUPS`(`lib/nav.ts`) — 항목 19개 동일 |
 * | `routeMap[item.id]`            | `item.href` (nav.ts 가 이미 경로를 들고 있다) |
 * | `iconMap[item.iconName]`       | **디자이너 아이콘 유지** — 아래 `DESIGNER_ICON` 참조 |
 * | 크레딧 `455`                   | `fetchCredits()` + 60초 폴링 + `stepd:credits-changed` |
 * | `STEPAI` / `STEPAI 운영자 · 팀장-CP` | 세션(워크스페이스명 / 이름 · 운영역할) |
 * | `<Link href="/">` (로그아웃)   | `logout()` → `/login` **전체 리로드** |
 * | `서버 연결됨 · 좋은 상태`      | `/health` 30초 폴링 3상태 |
 * | `badge: '예정'`                | 실제 처리 대기 건수(`badgeCounts.distributionFailed`) |
 *
 * ## 아이콘은 **디자이너 것**을 쓴다 — `nav.ts` 것이 아니다
 * `nav.ts` 의 `icon` 은 옛 디자인용이라 디자이너와 다르다(자동 배포: 우리 `Workflow` vs
 * 디자이너 `Zap`, 프로그램: `LayoutGrid` vs `Grid` …). "디자인 그대로" 가 원칙이므로
 * 경로별로 디자이너가 고른 아이콘을 여기서 덮는다. 구조(순서·라벨·href)는 nav.ts 가 정본이다 —
 * 그래야 메뉴 정본이 둘로 갈리지 않는다.
 *
 * ## 그룹 구성은 원본과 갈렸다 (2026-09-04)
 * 원본 목업은 `분석`·`생성`·`도구` 3그룹, 이식본은 `자동화`·`실험실` 2그룹이다.
 * 사용자 판단으로 **예비 기능 셋**(프로그램 분석 · 채널 분석 · 썸네일 생성)을 `실험실` 로
 * 내리면서 `분석` 이 비었고, 남은 둘(자동 배포 · 상품 링크)은 만드는 일이 아니라 자동으로
 * 도는 일이라 `생성` → `자동화` 가 됐다. 마크업은 그대로고 `NAV_GROUPS` 만 바뀐다 —
 * 이 컴포넌트는 그룹을 통째로 map 하므로 손댈 곳이 없다.
 *
 * ## '예정' 배지를 그대로 옮기지 않은 이유
 * 원본은 **채널 분석**에 `badge: '예정'` 이 붙어 있는데, 그건 목 데이터가 만들어진 시점의
 * 사실이고 그 화면은 지금 **실제로 돈다**. `analytics-reach.test.ts` 가 `nav.ts` 의
 * `/channel-analytics` 에 `soon: true` 를 **금지**하는 것도 같은 이유다(그 테스트는
 * "모은 데이터가 화면까지 닿는가" 를 지킨다). 배지 **슬롯과 스타일은 원본 그대로 두고**,
 * 무엇을 담을지만 실제 데이터로 바꿨다.
 */
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart2,
  Box,
  Briefcase,
  FileVideo,
  Folder,
  Grid,
  Image,
  LayoutDashboard,
  LogOut,
  Maximize,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Scissors,
  Search,
  Send,
  ShoppingBag,
  Stethoscope,
  Sun,
  TrendingUp,
  Zap,
} from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { useSession } from "@/lib/auth";
import { API_BASE, fetchCredits, logout } from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { NAV_GROUPS } from "@/lib/nav";
import { roleOf } from "@/lib/roles";

/**
 * 경로 → 디자이너가 고른 아이콘 (원본 `mockData.ts:39-79` 의 `iconName`).
 * 여기 없는 경로는 `nav.ts` 의 아이콘으로 떨어진다 — 나중에 메뉴가 늘어도 안 깨진다.
 */
const DESIGNER_ICON: Record<string, React.ElementType> = {
  "/dashboard": LayoutDashboard,
  "/programs": Grid,
  "/analyze": FileVideo,
  "/media": Folder,
  "/edits": Scissors,
  "/assets": Box,
  "/distribution": Send,
  "/performance": TrendingUp,
  "/search": Search,
  "/publish-channels": Radio,
  "/program-analytics": Activity,
  "/channel-analytics": BarChart2,
  "/thumbnails": Image,
  "/automation": Zap,
  "/commerce": ShoppingBag,
  "/trends": TrendingUp,
  "/business": Briefcase,
  "/ops": Stethoscope,
  "/reframe-lab": Maximize,
};

export function Sidebar() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`stepd-sidebar ${
        collapsed ? "w-[64px]" : "w-[240px]"
      } shrink-0 h-screen bg-[#111111] flex flex-col justify-between select-none text-[11px] transition-all duration-200 relative overflow-hidden`}
    >
      {/* Fixed Top Brand Header (STEP D Logo & Collapse Toggle Button - Height h-14 matching Header) */}
      <div className="h-14 shrink-0 px-3 bg-[#111111] border-b !border-white/10 z-10 flex items-center">
        <div
          className={`w-full flex items-center ${
            collapsed ? "justify-center" : "justify-between"
          } px-1`}
        >
          {!collapsed && (
            <Link href="/dashboard" className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer">
              <span className="font-['Outfit',sans-serif] font-black text-sm tracking-wider text-white">
                STEP D
              </span>
            </Link>
          )}

          {/* Toggle Sidebar Button */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            {collapsed ? (
              <PanelLeftOpen className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Scrollable Navigation Area */}
      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {/* Dynamic Navigation Sections */}
        {NAV_GROUPS.map((section, idx) => (
          <div key={idx} className="space-y-1">
            {section.label && !collapsed && (
              <h3 className="px-2.5 text-[10.5px] font-semibold text-slate-400 tracking-wider uppercase mb-1 mt-2">
                {section.label}
              </h3>
            )}
            <ul className="space-y-1">
              {section.items.map((item) => {
                const IconComponent = DESIGNER_ICON[item.href] || item.icon;
                const href = item.href;
                // 원본은 `pathname === href` 였다. 상세 경로(/programs/xxx)에서도 부모가 켜지도록
                // 하위 경로를 포함한다 — 디자이너가 그린 최상위 화면들에서는 결과가 동일하다.
                const isActive = pathname === href || pathname.startsWith(`${href}/`);

                return (
                  <li key={item.href}>
                    <Link
                      href={href}
                      title={collapsed ? item.label : undefined}
                      className={`w-full flex items-center ${
                        collapsed ? "justify-center px-0 py-2.5 rounded-full" : "justify-between px-3 py-2.5 rounded-md"
                      } transition-colors text-left ${
                        isActive
                          ? "bg-[#1C60FF] text-white font-bold shadow-sm cursor-pointer"
                          : "text-white/80 hover:bg-white/10 hover:text-white cursor-pointer"
                      }`}
                    >
                      <div className={`flex items-center ${collapsed ? "justify-center" : "gap-2.5"}`}>
                        <IconComponent className="w-4 h-4 shrink-0 text-white" />
                        {!collapsed && <span className="truncate text-xs">{item.label}</span>}
                      </div>
                      {!collapsed && <NavBadge badgeKey={item.badgeKey} isActive={isActive} />}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* Fixed Bottom Footer Area (Theme Toggle + Credit Info + User Profile) */}
      <div className="p-2.5 border-t !border-white/10 space-y-3 bg-[#111111] shrink-0">
        {/* Fixed Theme Toggle Button Pill Switch */}
        {!collapsed ? (
          <div className="px-0.5">
            <div className="w-full bg-[#1A1E29] p-1 rounded-full flex items-center justify-between border !border-white/10 shadow-inner">
              {/* Dark Option Pill */}
              <button
                onClick={() => {
                  if (theme !== "dark") toggleTheme();
                }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-full text-[10px] font-medium transition-all cursor-pointer ${
                  theme === "dark"
                    ? "bg-white text-slate-900 shadow-md font-bold"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Moon className={`w-3 h-3 ${theme === "dark" ? "text-slate-900 fill-current" : "text-slate-400"}`} />
                <span>Dark</span>
              </button>

              {/* Light Option Pill */}
              <button
                onClick={() => {
                  if (theme !== "light") toggleTheme();
                }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-full text-[10px] font-medium transition-all cursor-pointer ${
                  theme === "light"
                    ? "bg-white text-slate-900 shadow-md font-bold"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Sun className={`w-3 h-3 ${theme === "light" ? "text-slate-900" : "text-slate-400"}`} />
                <span>Light</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-center">
            <button
              onClick={toggleTheme}
              title="테마 토글"
              className="p-2 rounded-full bg-[#1A1E29] text-white hover:bg-white/20 transition-colors cursor-pointer border !border-white/10"
            >
              {theme === "dark" ? (
                <Moon className="w-3.5 h-3.5 text-[#1C60FF]" />
              ) : (
                <Sun className="w-3.5 h-3.5 text-amber-400" />
              )}
            </button>
          </div>
        )}

        {/* Credit Info (Clickable Link to /credits) */}
        {!collapsed && <CreditLine />}

        {/* User Account Tile */}
        <AccountTile collapsed={collapsed} />

        {/* Server Status Indicator */}
        {!collapsed && <ServerStatus />}
      </div>
    </aside>
  );
}

/**
 * 배지 — 원본의 슬롯·스타일 그대로, 내용만 실제 건수로.
 * 0 이면 **아예 안 그린다**. 회색 0 이 붙어 있으면 "왜 0이지" 를 매번 확인하게 된다.
 */
function NavBadge({ badgeKey, isActive }: { badgeKey?: string; isActive: boolean }) {
  const { badgeCounts } = useAppData();
  if (badgeKey !== "distributionFailed") return null;
  const n = badgeCounts.distributionFailed;
  if (!n) return null;
  return (
    <span
      className={`px-2 py-0.5 text-[10px] font-bold rounded-full ${
        isActive
          ? "bg-white/20 text-white !border-white/30"
          : "bg-white/10 text-white !border-white/20 border"
      }`}
    >
      {n}
    </span>
  );
}

/**
 * 크레딧 잔액 — 분석을 시작하기 **전에** 보여야 하는 숫자다(분석 한 번이 몇십 분이다).
 * 못 읽어도 링크는 살려 둔다: /credits 로 가는 유일한 진입점이라, 숨기면 조회가 실패한
 * 순간 충전 화면 자체가 앱에서 사라진다. 값만 "—" 로 둔다.
 */
function CreditLine() {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void fetchCredits()
        .then((c) => { if (alive) setBalance(c.balance); })
        .catch(() => { if (alive) setBalance(null); });
    };
    read();
    const t = setInterval(read, 60_000);
    // 충전 직후 60초를 기다리게 하지 않는다 — 크레딧 화면이 이 이벤트를 쏜다.
    window.addEventListener("stepd:credits-changed", read);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("stepd:credits-changed", read);
    };
  }, []);

  return (
    <Link
      href="/credits"
      title={balance === null ? "잔액을 읽지 못했습니다 — 크레딧 화면에서 확인하세요" : "크레딧 1개 = 분석 1분"}
      className="flex items-center justify-between px-2 py-1.5 rounded-full hover:bg-white/10 text-xs transition-colors cursor-pointer group"
    >
      <span className="text-slate-400 group-hover:text-slate-200 transition-colors">크레딧</span>
      <span className="font-bold text-white group-hover:text-[#1C60FF] transition-colors">
        {balance === null ? "—" : balance.toLocaleString("ko-KR")}
      </span>
    </Link>
  );
}

/** 계정 타일 — 원본의 `STEPAI` / `STEPAI 운영자 · 팀장-CP` 자리에 실제 세션을 넣는다. */
function AccountTile({ collapsed }: { collapsed: boolean }) {
  const session = useSession();
  return (
    <div
      className={`p-2 rounded-md bg-white/10 border !border-white/10 flex items-center ${
        collapsed ? "justify-center" : "justify-between"
      }`}
    >
      {!collapsed ? (
        <div className="flex flex-col min-w-0">
          {/* 워크스페이스(회사) 이름 — 어느 회사 것인지 바로 알게(사용자 2026-08-20). */}
          <span className="font-bold text-white text-xs truncate" title={session.workspaceName ?? undefined}>
            {session.workspaceName || "STEP D"}
          </span>
          <span className="text-[10.5px] text-slate-400 truncate">
            {session.user.name
              ? `${session.user.name} · ${roleOf(session.user.role).label}`
              : " "}
          </span>
        </div>
      ) : null}
      <button
        type="button"
        title="로그아웃"
        className="text-slate-400 hover:text-white transition-colors p-0.5 cursor-pointer"
        onClick={async () => {
          await logout();
          // 전체 리로드 — 안 그러면 SessionProvider 가 여전히 로그인 상태를 들고 있어
          // 화면이 그대로 보인다(데이터는 401 이라 비지만, 로그아웃된 것처럼 안 보인다).
          window.location.assign("/login");
        }}
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/**
 * 서버 연결 표시등 — 원본은 `서버 연결됨 · 좋은 상태` 가 **박혀** 있었다.
 *
 * ⚠️ **연결 여부를 묻는 데 데이터를 받아오지 않는다.** 예전엔 `/state`(11MB)를 폴링해서
 * 초록 점 하나에 시간당 수 GB 를 썼다(2026-08-31 실측 · Vercel FOT 로 과금).
 * 상태 확인은 상수 크기여야 한다 → `/health`.
 * 숨은 탭은 건너뛴다 — 아무도 안 보는 표시등을 위해 요청을 쏠 이유가 없다.
 */
function ServerStatus() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
        // **도달성** 표시등이지 그 라우트의 성공 여부가 아니다. 401·404 도 "연결됨" 이 맞다.
        // 프록시가 오리진에 못 닿으면 502 를 만들어 주므로 5xx 만 미연결로 본다.
        if (alive) setOk(res.status < 500);
      } catch {
        if (alive) setOk(false);
      }
    };
    void ping();
    const t = setInterval(() => { void ping(); }, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const dot = ok === null ? "bg-slate-500" : ok ? "bg-emerald-400 animate-pulse" : "bg-rose-500";
  const text = ok === null ? "서버 확인 중" : ok ? "서버 연결됨 · 좋은 상태" : "서버 연결 끊김";

  return (
    <div className="flex items-center gap-1.5 px-1 text-[10.5px] text-slate-400">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span>{text}</span>
    </div>
  );
}
