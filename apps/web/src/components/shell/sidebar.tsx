"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { navForRole } from "@/lib/nav";
import { useAppData } from "@/lib/data/store";
import { useSession } from "@/lib/auth";

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Sidebar() {
  const pathname = usePathname();
  const { badgeCounts } = useAppData();
  const { user } = useSession();
  const items = navForRole(user.role);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Off-canvas drawer on narrow viewports: the topbar hamburger dispatches
  // "toggle-sidebar" (same lightweight event pattern as the command palette).
  useEffect(() => {
    function onToggle() {
      setMobileOpen((v) => !v);
    }
    window.addEventListener("toggle-sidebar", onToggle);
    return () => window.removeEventListener("toggle-sidebar", onToggle);
  }, []);

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <>
      {/* backdrop — mobile only, when open */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[230px] flex-col border-r border-border bg-panel px-3 py-4 transition-transform duration-200 lg:translate-x-0",
          mobileOpen ? "translate-x-0 shadow-xl lg:shadow-none" : "-translate-x-full",
        )}
      >
        <Link href="/" className="flex items-center gap-2.5 px-2 pb-[18px] pt-1.5" aria-label="홈으로">
          <span
            className="grotesk flex size-[30px] items-center justify-center rounded-[9px] text-[15px] font-bold text-white"
            style={{ background: "linear-gradient(135deg,#8b93ff,#5a63e6)" }}
            aria-hidden
          >
            D
          </span>
          <span className="min-w-0">
            <span className="grotesk block text-[15px] font-bold leading-none tracking-tight">
              STEP D
            </span>
            <span className="mt-1 block text-[10.5px] text-muted-foreground/80">
              Media Production OS
            </span>
          </span>
        </Link>

        <nav className="flex flex-1 flex-col gap-0.5">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            const badge = item.badgeKey ? badgeCounts[item.badgeKey] : 0;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group flex items-center gap-[11px] rounded-[9px] px-2.5 py-2 text-[13.5px] transition-colors",
                  active
                    ? "bg-brand/10 font-semibold text-foreground"
                    : "font-medium text-[#a6a6a6] hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-brand" : "text-[#707070]")} />
                <span className="flex-1">{item.label}</span>
                {badge > 0 && (
                  <span
                    className={cn(
                      "min-w-5 rounded-md px-1.5 py-0.5 text-center text-[11px] font-bold tabular-nums",
                      item.badgeKey === "distributionFailed"
                        ? "bg-status-error/15 text-status-error"
                        : "bg-primary text-primary-foreground",
                    )}
                  >
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-2 flex items-center gap-2.5 border-t border-border px-1.5 pb-0.5 pt-2.5">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground"
            aria-hidden
          >
            {user.name.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold text-foreground">
              {user.name}
            </span>
            <span className="block text-[10.5px] text-muted-foreground">STEP D · {user.role}</span>
          </span>
        </div>
      </aside>
    </>
  );
}
