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
      <div className="lg:pl-56">
        <Topbar breadcrumb={breadcrumb} />
        <ConnectionBanner />
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
