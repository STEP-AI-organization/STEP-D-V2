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
  Scissors,
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
  badgeKey?: "distributionFailed";
  /**
   * 화면이 아직 스텁이다(무엇이 올 자리인지만 알려준다). 클릭은 막지 않는다 —
   * 스텁 화면이 스스로 예정임을 밝히고 있어서, 여기서는 **누르기 전에** 알려주는 게 목적이다.
   */
  soon?: boolean;
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
      // 권리·심의 게이트 뱃지는 제거 (2026-08-12 사용자 결정 — 데이터로 알 수 없어 무의미)
      { href: "/media", label: "미디어", icon: Clapperboard },
      // 편집본 = 외부에서 편집한 완성 영상 업로드 → 다중 채널 배포 (미디어와 분리).
      { href: "/edits", label: "편집본", icon: Scissors },
      { href: "/assets", label: "에셋", icon: Boxes },
      { href: "/distribution", label: "배포", icon: Send, badgeKey: "distributionFailed" },
      { href: "/performance", label: "성과", icon: BarChart3 },
      { href: "/search", label: "영상 검색", icon: Search },
      // 이 화면은 OAuth·세션 연결만 관리한다. 자동배포 설정은 /automation 한곳에서 한다.
      { href: "/publish-channels", label: "배포 채널", icon: Radio },
    ],
  },
  {
    label: "분석",
    items: [
      { href: "/program-analytics", label: "프로그램 분석", icon: Activity },
      { href: "/channel-analytics", label: "채널 분석", icon: TrendingUp, soon: true },
    ],
  },
  {
    label: "생성",
    items: [
      { href: "/thumbnails", label: "썸네일 생성", icon: ImageIcon },
      { href: "/automation", label: "자동 배포", icon: Workflow },
    ],
  },
  /**
   * FLOWS 재설계 밖의 화면들. **지우지 않고 남긴다** — 재설계가 대체하지 못한 일을
   * 실제로 하고 있고(트렌드 조사·큐 진단·사업 관리), 숨기면 "있는데 못 찾는" 상태가 된다.
   * 옛 디자인 그대로라 그룹을 나눠 그 사실이 드러나게 뒀다.
   */
  {
    label: "도구",
    items: [
      { href: "/trends", label: "유튜브 트렌드", icon: TrendingUp },
      { href: "/business", label: "사업 운영", icon: Boxes },
      { href: "/ops", label: "운영 진단", icon: Activity },
      // 내부 비교 뷰어(reframe-compare-viewer-plan §3) — 평가 데이터 구축용. 운영 배포 아님.
      { href: "/reframe-lab", label: "리프레임 랩", icon: Sparkles },
    ],
  },
];

/** 상단바 제목·부제 (README §0 — 세리프 17px 제목 + 11.5px 부제). */
export const SCREEN_META: Record<string, { title: string; subtitle: string }> = {
  "/dashboard": { title: "대시보드", subtitle: "수익 · 채널 순위 · 최근 배포" },
  "/programs": { title: "프로그램", subtitle: "편성·상태별 프로그램 목록" },
  "/analyze": { title: "영상 분석", subtitle: "회차 원본 → 추천 구간 → 미디어 생성" },
  "/media": { title: "미디어", subtitle: "숏폼·클립" },
  "/edits": { title: "편집본", subtitle: "외부 편집 완성 영상 업로드 → 다중 채널 배포" },
  "/assets": { title: "에셋", subtitle: "폴더·파일 · 이름 변경 없음(이름 기반 참조)" },
  "/distribution": { title: "배포", subtitle: "채널별 배포 로그 · 실패는 사람이 재시도" },
  "/performance": { title: "성과", subtitle: "채널별 지표 · 권한 없는 채널은 사유 표시" },
  "/search": { title: "영상 검색", subtitle: "자연어 질의로 구간 찾기" },
  "/publish-channels": { title: "배포 채널", subtitle: "YouTube·네이버·소셜 계정 연결 관리" },
  "/program-analytics": { title: "프로그램 분석", subtitle: "프로그램 현황 · 썸네일 스타일 분석" },
  "/channel-analytics": { title: "채널 분석", subtitle: "채널 단위 성과" },
  "/thumbnails": { title: "썸네일 생성", subtitle: "대상 선택 → 프롬프트 → 3안 중 대표 지정" },
  // 아래 넷은 화면 안에서 제목을 또 그리던 것들이라(구 PageHeader) 부제를 그쪽 설명으로
  // 옮겨 왔다 — 상단바가 한 번만 그린다. 제목 표기도 여기로 단일화한다.
  "/trends": { title: "유튜브 트렌드", subtitle: "국가·카테고리별 인기 급상승 영상 — 기획 참고용" },
  "/business": { title: "사업 운영", subtitle: "추천·클립·배포 결과를 프로그램/IP 단위로 — 부서 공유 · 편성 신호 · 승인 리스크" },
  "/ops": { title: "운영 진단", subtitle: "큐가 어떻게 도는지 · 업로드 영상에서 뭐가 나오고 뭐가 깨지는지" },
  "/reframe-lab": { title: "리프레임 랩", subtitle: "세로 4택 비교 — 후보·점수·타임라인 (내부 평가용)" },
  // 사이드바에 없는 화면도 여기 있어야 한다 — 빠지면 상단바가 "STEP-D" 로 폴백해서
  // 어느 화면인지 제목이 알려주지 못한다(/episodes/:id 는 prefix 매칭으로 걸린다).
  "/episodes": { title: "회차", subtitle: "원본 · 추천 구간 · 파이프라인 진행" },
  "/credits": { title: "크레딧", subtitle: "잔액 · 충전 · 사용 내역" },
  "/clips": { title: "클립", subtitle: "구 클립 목록 — 미디어 화면으로 대체됨" },
  "/analytics": { title: "성과 (구)", subtitle: "구 성과 화면 — 성과·프로그램/채널 분석으로 대체됨" },
  "/automation": { title: "자동 배포", subtitle: "프로그램·채널·일정·템플릿을 한곳에서 설정" },
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
