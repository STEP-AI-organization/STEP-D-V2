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
import { useAppData } from "@/lib/data/store";
import { fetchCredits, logout } from "@/lib/data/api";
import { NAV_GROUPS } from "@/lib/nav";
import { roleOf } from "@/lib/roles";
import { cn } from "@/lib/utils";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/proxy/api";
/** 이 번들이 빌드된 커밋 — 현재 배포와 다르면 낡은 탭이다(자동 새로고침 판정). */
const APP_BUILD_SHA = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 flex w-[206px] flex-col border-r"
      style={{ background: "var(--sd-sidebar-bg)", borderColor: "var(--sd-sidebar-border)", padding: "14px 10px" }}
    >
      <Link href="/dashboard" className="mb-3 flex items-center gap-2 px-2">
        {/* 랜딩·로그인과 같은 브랜드 마크 — 글자 "D" 배지는 브랜드 아이콘으로 교체(2026-08-13). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/stepd-icon-192.png"
          alt=""
          aria-hidden
          draggable={false}
          className="size-[18px] rounded-[4px]"
        />
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
                      {/* 눌러 보고 나서 "빈 화면이네" 를 알게 하지 않는다 — 미리 말해 준다. */}
                      {item.soon && (
                        <span
                          className="ml-auto shrink-0 rounded-[3px] px-1 text-[9.5px]"
                          title="화면 준비 중 — 무엇이 올 자리인지만 표시됩니다"
                          style={
                            active
                              ? { background: "rgba(255,255,255,.22)", color: "var(--sd-on-accent)" }
                              : { background: "var(--sd-card-sub)", color: "var(--sd-mut)" }
                          }
                        >
                          예정
                        </span>
                      )}
                      <NavBadge badgeKey={item.badgeKey} active={active} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <CreditBalance />
      <CurrentUser />
      <ConnectionStatus />
    </aside>
  );
}

/**
 * 크레딧 잔액 — 분석을 시작하기 **전에** 보여야 하는 숫자다.
 * 다 쓰고 나서 알면 이미 늦다(분석 한 번이 몇십 분이다).
 */
function CreditBalance() {
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

  // 못 읽으면 0 이라고 하지 않는다 — "잔액 없음"으로 오해하면 충전을 안 해도 될 때 하게 된다.
  // 다만 **링크까지 같이 숨기면 안 된다** — /credits 로 가는 유일한 진입점이라
  // 잔액 조회가 실패한 순간 충전 화면 자체가 앱에서 사라진다. 값만 "—" 로 둔다.
  const low = balance !== null && balance < 60; // 1시간 미만
  return (
    <Link
      href="/credits"
      className="mt-3 flex items-center gap-1.5 px-2 py-1 text-[10.5px]"
      style={{ color: low ? "var(--sd-danger-strong)" : "var(--sd-mut)" }}
      title={balance === null ? "잔액을 읽지 못했습니다 — 크레딧 화면에서 확인하세요" : "크레딧 1개 = 분석 1분"}
    >
      <span>크레딧</span>
      <span className="sd-mono ml-auto">
        {balance === null ? "—" : balance.toLocaleString("ko-KR")}
      </span>
    </Link>
  );
}

/**
 * 메뉴 배지 — 사람이 손봐야 하는 건수.
 *
 * 0 이면 아예 안 그린다. 회색 0 이 붙어 있으면 "배지가 있는데 왜 0이지"를 매번 확인하게 된다.
 */
function NavBadge({ badgeKey, active }: { badgeKey?: "gateHold" | "distributionFailed"; active: boolean }) {
  const { badgeCounts } = useAppData();
  // gateHold 배지는 제거됐다 (2026-08-12 — 권리 판정 UI 철수). 배포 실패만 남는다.
  if (badgeKey !== "distributionFailed") return null;

  const n = badgeCounts.distributionFailed;
  if (n === 0) return null;

  return (
    <span
      className="sd-mono ml-auto shrink-0 rounded-full px-1.5 text-[10px]"
      style={
        active
          ? { background: "rgba(255,255,255,.22)", color: "var(--sd-on-accent)" }
          : { background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }
      }
    >
      {n}
    </span>
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
        {/* 워크스페이스(회사) 이름 — 로그인 후 "어느 회사 것인지" 바로 알게(사용자 2026-08-20). 없으면 생략. */}
        {session.workspaceName ? (
          <div className="truncate text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }} title={`워크스페이스: ${session.workspaceName}`}>
            {session.workspaceName}
          </div>
        ) : null}
        <div className="truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          {session.user.name} · {roleOf(session.user.role).label}
        </div>
      </div>
      <button
        type="button"
        className="shrink-0 text-[10.5px] underline-offset-2 hover:underline"
        style={{ color: "var(--sd-mut)" }}
        onClick={async () => {
          await logout();
          // 전체 리로드 — 안 그러면 SessionProvider 가 여전히 로그인 상태를 들고 있어
          // 화면이 그대로 보인다(데이터는 401 이라 비지만, 로그아웃된 것처럼 안 보인다).
          window.location.assign("/login");
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
    // ⚠️ **연결 여부를 묻는 데 데이터를 받아오지 않는다.** 예전엔 `/state` 를 8초마다 불렀는데,
    // 그 응답이 11 MB 라 초록 점 하나 그리려고 탭당 시간당 ~5 GB 를 Cloud Run 에서 끌어왔다.
    // 프로덕션 웹은 /api/proxy(Vercel 함수)를 거치므로 그게 전부 **Fast Origin Transfer** 로
    // 청구됐다(2026-08-31 실측: 3시간 34.5 GB · /api/state 3,105회). 상태 확인은 상수 크기여야 한다.
    const ping = async () => {
      // 숨은 탭에서는 건너뛴다 — 아무도 안 보는 표시등을 위해 요청을 쏠 이유가 없다.
      // (버전 확인은 반대로 숨은 탭에서도 돌아야 한다 — 그게 낡은 탭을 고치는 경로다.)
      if (document.hidden) return;
      try {
        const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
        // 이건 **도달성** 표시등이지 그 라우트의 성공 여부가 아니다. 응답이 왔다는 건 서버에
        // 닿았다는 뜻이다 — 401(세션 만료)·404(구 리비전이라 라우트 없음)도 "연결됨" 이 맞다.
        // 프록시가 오리진에 못 닿으면 502 를 만들어 주므로 5xx 만 미연결로 본다.
        if (alive) setOk(res.status < 500);
      } catch {
        if (alive) setOk(false);
      }
    };
    /**
     * 새 배포가 뜨면 **스스로 새로고침한다.**
     *
     * 2026-08-31 에 이게 없어서, 코드를 고쳐 배포하고도 이미 열려 있는 탭들이 낡은 스크립트로
     * 11 MB 폴링을 계속 돌았다. 쓰는 사람이 여럿이면 "각자 새로고침하세요" 는 수단이 아니다.
     *
     * ⚠️ **작업 중인 화면은 안 건드린다.** 강제 새로고침은 저장 안 된 편집을 날릴 수 있어서,
     * 숨은 탭(=비용만 쓰는 탭)이거나 에디터 밖일 때만 한다. 에디터를 열어 둔 사람은 다음에
     * 나갈 때 갱신된다 — 돈이 새는 건 대부분 켜두고 잊은 탭이다.
     */
    const checkVersion = async () => {
      if (!APP_BUILD_SHA) return;                       // 로컬 빌드 — 비교 대상이 없다
      try {
        const res = await fetch("/api/app-version", { cache: "no-store" });
        if (!res.ok) return;
        const { sha } = (await res.json()) as { sha?: string };
        if (!sha || sha === APP_BUILD_SHA) return;
        if (document.hidden || !location.pathname.startsWith("/editor")) location.reload();
      } catch { /* 버전 확인 실패로 화면을 방해하지 않는다 */ }
    };

    void ping();
    void checkVersion();
    // 표시등에 8초는 과하다 — 사람이 서버 상태를 그 해상도로 볼 이유가 없다.
    const t = setInterval(() => { void ping(); void checkVersion(); }, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const label = ok === null ? "연결 확인 중…" : ok ? "서버 연결됨" : "서버 미연결";
  const color = ok === null ? "var(--sd-idle)" : ok ? "var(--sd-ok)" : "var(--sd-danger)";

  return (
    <div className="mt-3 flex items-center gap-1.5 px-2 pt-2" style={{ borderTop: "1px solid var(--sd-sidebar-border)" }}>
      <span className="size-[7px] shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <span className="truncate text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{label}</span>
    </div>
  );
}
