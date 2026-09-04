/**
 * 화면 카탈로그 — 도우미가 **링크로 가리켜도 되는 자리**의 전부.
 *
 * ## 왜 서버가 화면 목록을 또 갖고 있나
 *
 * 화면 경로의 정본은 `apps/web/src/lib/nav.ts` 다. 서버는 그걸 import 할 수 없다(별 패키지).
 * 그렇다고 모델이 경로를 **짐작해서** 링크를 만들게 두면, 그럴듯한 `/settings/notifications`
 * 같은 게 답변에 섞여 나간다 — 사용자는 눌러 보고 404 를 만난 뒤에야 안다. 도우미가 주는
 * 링크는 "여기로 가면 된다"는 약속이라 **틀린 링크는 안 주느니만 못하다.**
 *
 * 그래서 여기 목록을 두고, `chatbot-catalog.test.ts` 가 nav.ts 를 **소스로 읽어** 두 목록이
 * 같은지 검사한다. 화면을 추가·삭제하면 그 테스트가 먼저 깨진다.
 *
 * ## `what` 은 프롬프트에 그대로 실린다
 *
 * 모델이 "이 질문은 어느 화면 얘기인가" 를 고르는 근거다. 화면 이름만으로는 안 갈린다
 * (`/media` 와 `/edits` 는 이름만 보면 구분이 안 된다). 한 줄로 **그 화면에서 하는 일**을
 * 적는다 — 사용자가 쓰는 말로.
 */

export interface Screen {
  /** 앱 안의 경로. 위젯이 그대로 링크로 쓴다(절대 URL 로 만들지 않는다). */
  href: string;
  /** 사이드바에 보이는 이름 그대로. 다른 이름을 지어내면 사용자가 못 찾는다. */
  label: string;
  /** 그 화면에서 하는 일 — 프롬프트에 실려 모델이 화면을 고르는 근거가 된다. */
  what: string;
}

/**
 * nav.ts 의 `NAV_GROUPS` 와 같은 순서·같은 라벨. 순서를 맞춰 두면 사람이 두 파일을
 * 나란히 놓고 비교할 수 있다.
 */
export const SCREENS: Screen[] = [
  { href: "/dashboard", label: "대시보드", what: "수익·채널 순위·최근 배포를 한눈에 본다. 로그인하면 처음 열리는 화면" },
  { href: "/programs", label: "프로그램", what: "프로그램(방송 시리즈)을 만들고 출연진(캐스트)을 미리 등록한다" },
  { href: "/analyze", label: "영상 분석", what: "회차 원본 영상을 올리고 AI 분석을 돌려 추천 구간을 받는다" },
  { href: "/media", label: "미디어", what: "분석에서 만들어진 숏폼·클립 목록. 여기서 편집기로 들어간다" },
  { href: "/edits", label: "편집본", what: "밖에서 편집을 끝낸 완성 영상을 올려 여러 채널로 배포한다" },
  { href: "/assets", label: "에셋", what: "로고·자막 폰트 같은 파일을 폴더로 보관한다" },
  { href: "/distribution", label: "배포", what: "채널별 배포 기록과 실패 사유. 실패한 건을 다시 보낸다" },
  { href: "/performance", label: "성과", what: "배포한 영상의 조회수·시청시간 같은 채널별 지표" },
  { href: "/search", label: "영상 검색", what: "'누가 화내는 장면' 처럼 말로 물어 지난 회차 구간을 찾는다" },
  { href: "/publish-channels", label: "배포 채널", what: "유튜브·인스타그램·틱톡·네이버 계정을 연결하고 관리한다" },
  { href: "/program-analytics", label: "프로그램 분석", what: "프로그램 단위 현황과 썸네일 스타일 분석" },
  { href: "/channel-analytics", label: "채널 분석", what: "채널 단위 성과 추이" },
  { href: "/thumbnails", label: "썸네일 생성", what: "대상을 고르고 문구를 넣어 썸네일 3안을 만들고 대표를 지정한다" },
  { href: "/automation", label: "자동 배포", what: "프로그램·채널·요일·시간대를 정해 두면 분석부터 배포까지 알아서 돈다" },
  { href: "/commerce", label: "상품 링크", what: "영상에서 찾은 상품 링크를 검토한다. 승인한 것만 발행 설명란에 붙는다" },
  { href: "/full-auto", label: "완전자동화", what: "수집할 유튜브 채널을 지정하면 긴 영상을 자동으로 가져와 숏폼으로 만들어 배포한다" },
  { href: "/trends", label: "유튜브 트렌드", what: "국가·카테고리별 인기 급상승 영상 — 기획 참고용" },
  { href: "/business", label: "사업 운영", what: "추천·클립·배포 결과를 프로그램/IP 단위로 모아 부서 공유용으로 본다" },
  { href: "/ops", label: "운영 진단", what: "작업 대기열이 어떻게 도는지, 어디서 막혔는지 진단한다" },
  { href: "/reframe-lab", label: "리프레임 랩", what: "세로 화면 레이아웃 정답을 모으는 내부 도구" },

  // ── 사이드바에 없지만 링크로 보내야 하는 자리 ───────────────────────────────
  // nav.ts 의 SCREEN_META 에는 있다. 메뉴가 없어서 **말로 설명해선 도달할 수 없는** 화면이라
  // 오히려 링크가 꼭 필요하다.
  { href: "/credits", label: "크레딧", what: "잔액·충전·사용 내역. 결제 카드와 자동 충전 설정" },
  { href: "/episodes", label: "회차 상세", what: "회차 하나의 원본·추천 구간·분석 진행 상황" },
];

/** 경로 → 화면. 링크 검사와 프롬프트 조립이 같은 표를 본다. */
const BY_HREF = new Map(SCREENS.map((s) => [s.href, s]));

/**
 * 이 경로가 실재하는 화면인가. `/episodes/ep_1234` 처럼 **하위 경로도 통과**시킨다 —
 * 회차·프로그램 상세는 id 가 붙어야 의미가 있고, 그 id 는 조회 툴이 실제 DB 에서 가져온다.
 */
export function knownScreen(href: string): Screen | null {
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const exact = BY_HREF.get(path);
  if (exact) return exact;
  // 가장 긴 접두사부터 — `/programs/:id/settings` 가 `/programs` 로 걸린다.
  let best: Screen | null = null;
  for (const s of SCREENS) {
    if (path.startsWith(`${s.href}/`) && (!best || s.href.length > best.href.length)) best = s;
  }
  return best;
}

/**
 * 링크로 허용하는 **바깥** 호스트. 도구가 실제 배포 기록에서 가져온 게시물 주소만 나간다.
 * 여기 없는 호스트는 링크가 벗겨진다 — 모델이 "자세한 건 공식 문서에서" 하며 그럴듯한
 * 남의 사이트 주소를 지어내는 것을 막는다.
 */
const EXTERNAL_HOSTS = [
  "youtube.com", "youtu.be", "instagram.com", "facebook.com", "fb.watch",
  "tiktok.com", "naver.com", "stepd.stepai.kr",
];

function externalAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return EXTERNAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export interface AnswerLink {
  label: string;
  href: string;
}

/** 답변에 붙일 링크 상한. 여섯 개가 넘어가면 사람이 안 읽고 넘긴다. */
export const MAX_LINKS = 6;

/**
 * 답변 후처리 — **모르는 곳을 가리키는 링크를 벗긴다.**
 *
 * 링크 문법(`[말](경로)`)만 지우고 **말은 남긴다.** 문장을 통째로 버리면 답이 이상해지고,
 * 링크를 그대로 두면 사용자가 404 를 만난다. 사이 값이 "글자는 맞되 못 누른다" 다.
 *
 * 통과한 링크는 본문에도 남고 `links` 로도 나간다 — 위젯이 마크다운을 파싱하지 않고
 * 버튼을 그릴 수 있게.
 */
export function sanitizeLinks(markdown: string): { text: string; links: AnswerLink[] } {
  const links: AnswerLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, href: string) => {
    if (seen.has(href) || links.length >= MAX_LINKS) return;
    seen.add(href);
    links.push({ label: label.trim(), href });
  };

  const text = markdown.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
    const isInternal = href.startsWith("/");
    const ok = isInternal ? knownScreen(href) !== null : externalAllowed(href);
    if (!ok) return label;                       // 링크만 벗기고 말은 남긴다
    add(label, href);
    return whole;
  });

  // 맨 텍스트로 쓴 경로도 줍는다 — **실측 때문이다**(2026-09-03). 모델에게 마크다운 링크로
  // 쓰라고 시켜도 `/automation` 이나 `` `/automation` `` 처럼 그냥 적는 일이 잦다. 그러면
  // 본문은 멀쩡한데 위젯이 그릴 버튼이 하나도 없다 — 링크가 제품의 요구사항인데 조용히
  // 사라지는 종류의 고장이다.
  //
  // 지어낼 여지는 없다: 카탈로그를 통과한 경로만 담고, **본문은 건드리지 않는다.**
  for (const m of text.matchAll(/(?<![\w/])\/[a-z][a-z0-9-]*(?:\/[A-Za-z0-9_-]+)*/g)) {
    const href = m[0];
    const screen = knownScreen(href);
    if (screen) add(screen.label, href);
  }

  return { text, links };
}

/** 프롬프트에 싣는 화면 목록. 한 줄에 하나 — 토큰이 가장 적게 드는 형태다. */
export function screenCatalogText(): string {
  return SCREENS.map((s) => `${s.href} · ${s.label} — ${s.what}`).join("\n");
}
