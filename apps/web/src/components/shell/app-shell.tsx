import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { ConnectionBanner } from "@/components/shell/connection-banner";

/** App chrome: fixed sidebar + sticky topbar + scrollable content region. */
export function AppShell({
  children,
  breadcrumb,
}: {
  children: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <Sidebar />
      <div className="lg:pl-57.5">
        <Topbar breadcrumb={breadcrumb} />
        <ConnectionBanner />
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-7.5 lg:py-6.5">
          {children}
        </main>
        {/* Legal links must be reachable from the site root without opening a menu
            or signing in — required by the TikTok app review checklist. */}
        <footer className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-2 border-t border-border px-4 py-5 text-xs text-muted-foreground sm:px-6 lg:px-7.5">
          <span>© 2026 STEP AI Inc.</span>
          <a href="/privacy" className="hover:text-foreground">개인정보처리방침</a>
          <a href="/terms" className="hover:text-foreground">서비스 이용약관</a>
          <a href="/data-deletion" className="hover:text-foreground">데이터 삭제 요청</a>
        </footer>
      </div>
    </div>
  );
}
