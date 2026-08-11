/**
 * 사이드바 내비 (README §0 "앱 셸").
 *
 * 그룹 3개 — 기본 / 분석 / 생성. 라벨·순서·경로는 디자인 확정본 그대로다.
 * 역할별 노출 제어는 여기서 하지 않는다. **범위(scope)는 목록 자체가 줄어드는 것**이지
 * 메뉴가 사라지는 게 아니고(FLOWS.md:172), 수익은 메뉴가 아니라 값이 "비공개"로
 * 바뀐다(FLOWS.md:169). 메뉴를 감추면 "왜 안 보이지"에서 막힌다.
 */
import {
  Activity,
  BarChart3,
  Boxes,
  Clapperboard,
  Film,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutGrid,
  Radio,
  Search,
  Send,
  Sparkles,
  TrendingUp,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type { Role } from "@/lib/roles";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** 배지 숫자를 붙일 자리 (미처리 건수 등). */
  badgeKey?: "gateHold" | "distributionFailed";
}

export interface NavGroup {
  /** 그룹 라벨. 첫 그룹은 라벨 없이 바로 항목이 온다. */
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "대시보드", icon: LayoutDashboard },
      { href: "/programs", label: "프로그램", icon: LayoutGrid },
      { href: "/analyze", label: "영상 분석", icon: Film },
      { href: "/media", label: "미디어", icon: Clapperboard, badgeKey: "gateHold" },
      { href: "/assets", label: "에셋", icon: Boxes },
      { href: "/distribution", label: "배포", icon: Send, badgeKey: "distributionFailed" },
      { href: "/performance", label: "성과", icon: BarChart3 },
      { href: "/search", label: "영상 검색", icon: Search },
      // 채널은 **연결이 먼저**다 — 옛 화면(OAuth 등록·해제)이 그 일을 하고 있고 잘 돈다.
      // 배포 규칙은 그 화면의 채널 행에서 바로 열린다. 규칙 전용 목록은 /channels.
      { href: "/publish-channels", label: "배포 채널", icon: Radio },
    ],
  },
  {
    label: "분석",
    items: [
      { href: "/program-analytics", label: "프로그램 분석", icon: Activity },
      { href: "/channel-analytics", label: "채널 분석", icon: TrendingUp },
    ],
  },
  {
    label: "생성",
    items: [
      { href: "/thumbnails", label: "썸네일 생성", icon: ImageIcon },
      { href: "/automation", label: "자동 배포", icon: Workflow },
    ],
  },
];

/** 상단바 제목·부제 (README §0 — 세리프 17px 제목 + 11.5px 부제). */
export const SCREEN_META: Record<string, { title: string; subtitle: string }> = {
  "/dashboard": { title: "대시보드", subtitle: "게이트 현황 · 수익 · 채널 순위 · 최근 배포" },
  "/programs": { title: "프로그램", subtitle: "편성·상태별 프로그램 목록" },
  "/analyze": { title: "영상 분석", subtitle: "회차 원본 → 추천 구간 → 미디어 생성" },
  "/media": { title: "미디어", subtitle: "숏폼·클립 · 권리/심의 게이트" },
  "/assets": { title: "에셋", subtitle: "폴더·파일 · 이름 변경 없음(이름 기반 참조)" },
  "/distribution": { title: "배포", subtitle: "채널별 배포 로그 · 실패는 사람이 재시도" },
  "/performance": { title: "성과", subtitle: "채널별 지표 · 권한 없는 채널은 사유 표시" },
  "/search": { title: "영상 검색", subtitle: "자연어 질의로 구간 찾기" },
  "/publish-channels": { title: "배포 채널", subtitle: "채널 연결 · 채널별 배포 규칙" },
  "/channels": { title: "배포 규칙", subtitle: "채널별 업로드 규칙 한눈에 보기" },
  "/program-analytics": { title: "프로그램 분석", subtitle: "프로그램 단위 성과" },
  "/channel-analytics": { title: "채널 분석", subtitle: "채널 단위 성과" },
  "/thumbnails": { title: "썸네일 생성", subtitle: "대상 선택 → 프롬프트 → 3안 중 대표 지정" },
  "/automation": { title: "자동 배포", subtitle: "규칙 기반 순방 · 게이트를 건너뛰지 않음" },
};

export function screenMetaFor(pathname: string): { title: string; subtitle: string } {
  if (SCREEN_META[pathname]) return SCREEN_META[pathname];
  // /programs/:id 처럼 하위 경로는 상위 화면 메타를 쓴다.
  const base = Object.keys(SCREEN_META)
    .filter((k) => k !== "/" && pathname.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? SCREEN_META[base] : { title: "STEP-D", subtitle: "" };
}

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
