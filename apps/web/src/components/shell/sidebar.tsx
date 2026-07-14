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
          "fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-border bg-card transition-transform duration-200 lg:translate-x-0",
          mobileOpen ? "translate-x-0 shadow-xl lg:shadow-none" : "-translate-x-full",
        )}
      >
        <Link href="/" className="flex h-14 items-center gap-2 px-5" aria-label="홈으로">
          <span className="text-lg font-bold tracking-tight">STEPD</span>
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground">
            v2
          </span>
        </Link>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
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
                  "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {active && (
                  <span
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
                    aria-hidden
                  />
                )}
                <Icon className="size-4 shrink-0" />
                <span className="flex-1">{item.label}</span>
                {badge > 0 && (
                  <span
                    className={cn(
                      "min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums",
                      item.badgeKey === "distributionFailed"
                        ? "bg-status-error/15 text-status-error"
                        : active
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground",
                    )}
                  >
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border p-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{user.name}</div>
          <div>KT ENA · {user.role}</div>
        </div>
      </aside>
    </>
  );
}
