/**
 * STEP-D — primary navigation (work-centric IA, plan §5.2).
 * 7 areas ordered by workflow. `badgeKey` maps to a live count in the data layer.
 */
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Clapperboard,
  Inbox,
  LayoutGrid,
  Send,
  Settings,
  Sparkles,
  TrendingUp,
} from "lucide-react";

export type Role = "user" | "admin" | "superadmin";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Which mock/live counter to show as a badge, if any. */
  badgeKey?: "inbox" | "recommendations" | "distributionFailed";
  /** Minimum role required to see this item. */
  roles?: Role[];
}

export const NAV: NavItem[] = [
  { href: "/", label: "오늘 할 일", icon: Inbox, badgeKey: "inbox" },
  { href: "/programs", label: "콘텐츠", icon: LayoutGrid },
  { href: "/recommendations", label: "추천 & 채택", icon: Sparkles, badgeKey: "recommendations" },
  { href: "/clips", label: "클립", icon: Clapperboard },
  { href: "/distribution", label: "배포", icon: Send, badgeKey: "distributionFailed" },
  { href: "/analytics", label: "성과", icon: BarChart3, roles: ["admin", "superadmin"] },
  { href: "/channels", label: "채널 트렌드", icon: TrendingUp, roles: ["admin", "superadmin"] },
  { href: "/system", label: "시스템", icon: Settings, roles: ["admin", "superadmin"] },
];

export function navForRole(role: Role): NavItem[] {
  return NAV.filter((item) => !item.roles || item.roles.includes(role));
}
