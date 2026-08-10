import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";

/**
 * 앱 셸 (README §0) — 좌측 고정 사이드바 206px + 상단바 54px + 스크롤 본문 padding 20px.
 * 본문 배경은 앱 바깥 배경(#eceae5) 위에 화면별 max-width 로 얹힌다.
 */
export function AppShell({
  children,
  breadcrumb,
}: {
  children: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen" style={{ background: "var(--sd-app-bg)" }}>
      <Sidebar />
      <div className="pl-[206px]">
        <Topbar breadcrumb={breadcrumb} />
        <main className="p-5">{children}</main>

        {/* 법적 링크는 로그인·메뉴 없이 루트에서 닿아야 한다 (TikTok 앱 심사 체크리스트). */}
        <footer
          className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-5 text-[10.5px]"
          style={{ borderTop: "1px solid var(--sd-border)", color: "var(--sd-mut)" }}
        >
          <span>© 2026 STEP AI Inc.</span>
          <a href="/privacy" className="hover:underline">개인정보처리방침</a>
          <a href="/terms" className="hover:underline">서비스 이용약관</a>
          <a href="/data-deletion" className="hover:underline">데이터 삭제 요청</a>
        </footer>
      </div>
    </div>
  );
}
