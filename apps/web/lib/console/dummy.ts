import type { Clip } from "./map";

/* ============================================================================
 * Dummy datasets ported from the "수익 콘솔" HTML DCLogic. Screens prefer real
 * API data and fall back to these so the UI renders identically to the mockup
 * where no backend data exists (revenue, commerce, social-blade estimates).
 * Every number here is an ESTIMATE — screens surface a "추정" badge.
 * ========================================================================== */

/* ----- revenue channel split (dashboard donut / breakdown) ----- */
export type RevChannel = { key: string; name: string; pct: number; color: string; smr: boolean; rpm: string; share: string };
export const REV_CHANNELS: RevChannel[] = [
  { key: "yt", name: "YouTube", pct: 52, color: "#FF0000", smr: false, rpm: "₩2,000", share: "100%" },
  { key: "nv", name: "네이버(SMR)", pct: 18, color: "#03C75A", smr: true, rpm: "₩1,500", share: "90%" },
  { key: "kk", name: "카카오(SMR)", pct: 14, color: "#FFCD00", smr: true, rpm: "₩1,500", share: "90%" },
  { key: "meta", name: "Meta", pct: 9, color: "#1877F2", smr: false, rpm: "₩1,200", share: "95%" },
  { key: "tt", name: "TikTok", pct: 7, color: "#111111", smr: false, rpm: "₩900", share: "95%" },
];

export const CONTENT_REV_MONTH = 4820000; // 이번 달 콘텐츠 매출(추정)
export const CUMULATIVE_REV = 38400000; // 누적 매출(추정)

/* ----- revenue trend (line/bar) — source: 채널 / 커머스 / 전체 ----- */
export type TrendPoint = { label: string; ch: number; cm: number };
export const TREND_6: TrendPoint[] = [
  { label: "1월", ch: 2180000, cm: 42000000 },
  { label: "2월", ch: 2550000, cm: 51000000 },
  { label: "3월", ch: 3020000, cm: 60000000 },
  { label: "4월", ch: 3340000, cm: 68000000 },
  { label: "5월", ch: 3650000, cm: 74000000 },
  { label: "6월", ch: 4820000, cm: 81900000 },
];
export const TREND_PREV: TrendPoint[] = [
  { label: "7월", ch: 1240000, cm: 16000000 },
  { label: "8월", ch: 1480000, cm: 19000000 },
  { label: "9월", ch: 1710000, cm: 23000000 },
  { label: "10월", ch: 1960000, cm: 28000000 },
  { label: "11월", ch: 2050000, cm: 33000000 },
  { label: "12월", ch: 2010000, cm: 38000000 },
];

/* ----- KPI cards ----- */
export type Kpi = { label: string; value: string; caption: string; live: boolean };
export const KPIS: Kpi[] = [
  { label: "누적 수익", value: "₩38,400,000", caption: "올해 콘텐츠가 번 돈", live: false },
  { label: "발행 클립", value: "1,863", caption: "이번 달 +312", live: true },
  { label: "총 조회수", value: "1,240만", caption: "도달한 시청자", live: true },
  { label: "활성 프로그램", value: "14", caption: "운영 중", live: true },
];

/* ----- program table + clip-level drilldown (AI 귀인) ----- */
export type ProgramClip = {
  title: string;
  viewsRaw: number;
  views: string;
  revenue: string;
  pct: number;
  completion: string;
  avg: string;
  lift: string;
  ai: string;
};
export type Program = {
  id: string;
  name: string;
  sub: string;
  initial: string;
  clips: number;
  viewsN: number;
  views: string;
  revenueN: number;
  status: string;
  thumbBg: string;
  thumbFg: string;
  clipList: ProgramClip[];
};

export const PROGRAMS: Program[] = [
  {
    id: "p1", name: "쯔양먹방", sub: "5회 · 음식", initial: "쯔", clips: 30, viewsN: 380000, views: "38만", revenueN: 267500, status: "배포완료",
    thumbBg: "#FDEBE3", thumbFg: "#C2603A",
    clipList: [
      { title: "한입에 등극", viewsRaw: 72000, views: "7.2만", revenue: "₩14,400", pct: 18, completion: "72%", avg: "0:41", lift: "+63%", ai: "KT ENA 시청자는 '먹방 리액션 + 반전' 구간에서 가장 오래 머뭅니다. 유사 레퍼런스 대비 시청 지속이 도드라져 나옵니다." },
      { title: "12인분 클리어", viewsRaw: 51000, views: "5.1만", revenue: "₩10,200", pct: 13, completion: "68%", avg: "0:37", lift: "+44%", ai: "양 폭발 구간의 '숫자 자막'에서 재시청이 급증합니다. 댓글 키워드는 '대단하다'에 집중됩니다." },
      { title: "사장님 표정", viewsRaw: 34000, views: "3.4만", revenue: "₩6,800", pct: 9, completion: "74%", avg: "0:33", lift: "+38%", ai: "점원 리액션 컷이 짧은 호흡 시청자에게 강합니다. 0:08 지점 이후가 최적입니다." },
    ],
  },
  {
    id: "p2", name: "현역가왕2", sub: "12회 · 음악", initial: "현", clips: 48, viewsN: 920000, views: "92만", revenueN: 640000, status: "배포완료",
    thumbBg: "#EDE9FE", thumbFg: "#6C5CE7",
    clipList: [
      { title: "무대 직캠 하이라이트", viewsRaw: 210000, views: "21만", revenue: "₩42,000", pct: 21, completion: "77%", avg: "1:12", lift: "+58%", ai: "고음 클라이맥스 직전 3초의 '숨 고르기'에서 이탈이 사라집니다. 무대 직캠은 완주율이 구조적으로 높습니다." },
      { title: "심사위원 기립", viewsRaw: 140000, views: "14만", revenue: "₩28,000", pct: 14, completion: "70%", avg: "0:48", lift: "+51%", ai: "리액션 인서트가 감정 곡선을 한 번 더 끌어올립니다. 공유율이 평균의 2.1배입니다." },
    ],
  },
  {
    id: "p3", name: "강철부대W", sub: "8회 · 서바이벌", initial: "강", clips: 36, viewsN: 710000, views: "71만", revenueN: 498000, status: "배포중",
    thumbBg: "#E6F0E9", thumbFg: "#2E7D52",
    clipList: [
      { title: "마지막 1초 역전", viewsRaw: 185000, views: "18.5만", revenue: "₩37,000", pct: 23, completion: "81%", avg: "0:55", lift: "+72%", ai: "승부 결과를 끝까지 숨긴 편집이 완주율을 끌어올립니다. '역전' 키워드 클립이 회차 수익의 절반 이상입니다." },
      { title: "팀 작전 회의", viewsRaw: 96000, views: "9.6만", revenue: "₩19,200", pct: 11, completion: "64%", avg: "0:39", lift: "+33%", ai: "전략 설명 구간은 코어 팬 재시청이 강합니다. 신규 유입보다 충성 시청에 기여합니다." },
    ],
  },
  {
    id: "p4", name: "지구마불 시즌3", sub: "7회 · 여행", initial: "지", clips: 27, viewsN: 540000, views: "54만", revenueN: 378000, status: "배포완료",
    thumbBg: "#E3F1FB", thumbFg: "#2A6FA8",
    clipList: [
      { title: "현지 시장 먹부림", viewsRaw: 128000, views: "12.8만", revenue: "₩25,600", pct: 19, completion: "69%", avg: "0:44", lift: "+47%", ai: "현지 음식 클로즈업 + 환율 자막 조합이 저장률을 높입니다. 여행 정보성 시청 패턴이 뚜렷합니다." },
      { title: "길 잃은 PD", viewsRaw: 74000, views: "7.4만", revenue: "₩14,800", pct: 11, completion: "66%", avg: "0:35", lift: "+29%", ai: "예측 불가 상황 클립은 초반 3초 후킹이 강합니다. 신규 시청 유입 비중이 높습니다." },
    ],
  },
  {
    id: "p5", name: "나는 솔로 22기", sub: "9회 · 리얼리티", initial: "나", clips: 41, viewsN: 1300000, views: "130만", revenueN: 910000, status: "배포완료",
    thumbBg: "#FCE7F0", thumbFg: "#B23A6B",
    clipList: [
      { title: "데이트 상대 선택 순간", viewsRaw: 320000, views: "32만", revenue: "₩64,000", pct: 24, completion: "79%", avg: "1:03", lift: "+68%", ai: "선택 직전 '정적 + 자막 카운트' 연출에서 시청자가 가장 오래 머뭅니다. 댓글 참여가 폭발합니다." },
      { title: "반전 고백", viewsRaw: 198000, views: "19.8만", revenue: "₩39,600", pct: 15, completion: "73%", avg: "0:52", lift: "+55%", ai: "감정 반전 구간은 공유·재시청 모두 강합니다. '먹방 리액션' 다음으로 시청자가 선호하는 패턴입니다." },
    ],
  },
  {
    id: "p6", name: "미스터리 수사단", sub: "4회 · 추리", initial: "미", clips: 22, viewsN: 330000, views: "33만", revenueN: 231000, status: "예약",
    thumbBg: "#ECECF2", thumbFg: "#4A4F5C",
    clipList: [
      { title: "결정적 단서", viewsRaw: 88000, views: "8.8만", revenue: "₩17,600", pct: 20, completion: "75%", avg: "0:47", lift: "+49%", ai: "단서 공개 직전 '넘기기 유도' 편집이 재시청을 만듭니다. 추리 장르 코어 시청 패턴입니다." },
    ],
  },
  {
    id: "p7", name: "한일가왕전", sub: "3회 · 음악", initial: "한", clips: 19, viewsN: 610000, views: "61만", revenueN: 427000, status: "배포중",
    thumbBg: "#FDF0DC", thumbFg: "#B07A1E",
    clipList: [
      { title: "듀엣 하이라이트", viewsRaw: 166000, views: "16.6만", revenue: "₩33,200", pct: 22, completion: "78%", avg: "1:08", lift: "+61%", ai: "양국 시청자 모두에서 완주율이 높습니다. 글로벌 자막 클립이 해외 유입을 만듭니다." },
    ],
  },
  {
    id: "p8", name: "골 때리는 그녀들", sub: "16회 · 스포츠", initial: "골", clips: 33, viewsN: 880000, views: "88만", revenueN: 616000, status: "배포완료",
    thumbBg: "#E7F1EC", thumbFg: "#2E7D52",
    clipList: [
      { title: "극장골 모음", viewsRaw: 240000, views: "24만", revenue: "₩48,000", pct: 22, completion: "80%", avg: "0:58", lift: "+66%", ai: "골 장면 직전 '관중 리액션 인서트'가 긴장을 만들어 완주율을 끌어올립니다. 스포츠 하이라이트에 적합한 패턴입니다." },
      { title: "감독 새역할", viewsRaw: 112000, views: "11.2만", revenue: "₩22,400", pct: 12, completion: "67%", avg: "0:41", lift: "+35%", ai: "인물 캐릭터 클립은 시즌 충성도를 높입니다. 신규보다 재방문 시청에 기여합니다." },
    ],
  },
];

/* ----- commerce products (PPL → external affiliate, dummy platform/rate/rev) ----- */
export type CommerceProduct = {
  id: string;
  brand: string;
  product: string;
  cat: string;
  prog: string;
  ts: string;
  plat: string;
  platColor: string;
  rate: string;
  clicks: string;
  revN: number;
  bg: string;
  fg: string;
};
export const PRODUCTS: CommerceProduct[] = [
  { id: "pr1", brand: "농심", product: "신라면 멀티팩", cat: "식품", prog: "쯔양먹방 · 5회", ts: "02:14", plat: "쿠팡", platColor: "#E94928", rate: "3%", clicks: "12,400", revN: 8600000, bg: "#FDEBE3", fg: "#C2603A" },
  { id: "pr2", brand: "삼성전자", product: "갤럭시 버즈3", cat: "전자·IT", prog: "현역가왕2 · 7회", ts: "41:05", plat: "쿠팡", platColor: "#E94928", rate: "3.5%", clicks: "8,200", revN: 14200000, bg: "#E6EAF5", fg: "#2D4FA0" },
  { id: "pr3", brand: "나이키", product: "머큐리얼 축구화", cat: "스포츠", prog: "골 때리는 그녀들 · 12회", ts: "27:33", plat: "쿠팡", platColor: "#E94928", rate: "4%", clicks: "9,600", revN: 11800000, bg: "#ECECF2", fg: "#16181D" },
  { id: "pr4", brand: "올리브영", product: "로즈 립틴트", cat: "패션·뷰티", prog: "나는 솔로 22기 · 5회", ts: "22:07", plat: "올리브영", platColor: "#3CB05A", rate: "8%", clicks: "15,300", revN: 9600000, bg: "#E6F0E9", fg: "#1F8A5B" },
  { id: "pr5", brand: "다이슨", product: "에어랩 멀티스타일러", cat: "패션·뷰티", prog: "나는 솔로 22기 · 3회", ts: "18:42", plat: "쿠팡", platColor: "#E94928", rate: "3.5%", clicks: "6,800", revN: 21000000, bg: "#EDE9FE", fg: "#6C5CE7" },
  { id: "pr6", brand: "코카콜라", product: "제로 350ml", cat: "식품", prog: "쯔양먹방 · 5회", ts: "05:51", plat: "쿠팡", platColor: "#E94928", rate: "3%", clicks: "5,400", revN: 4200000, bg: "#FDEBEA", fg: "#C0392B" },
  { id: "pr7", brand: "스탠리", product: "어드벤처 텀블러", cat: "리빙", prog: "지구마불 시즌3 · 4회", ts: "33:18", plat: "11번가", platColor: "#FF5A4D", rate: "4%", clicks: "7,100", revN: 5800000, bg: "#E6F0E9", fg: "#1F7A4D" },
  { id: "pr8", brand: "무신사", product: "스탠다드 후디", cat: "패션·뷰티", prog: "강철부대W · 3회", ts: "14:29", plat: "무신사", platColor: "#16181D", rate: "5%", clicks: "4,900", revN: 6700000, bg: "#ECECF2", fg: "#16181D" },
];

export const PLATFORM_META: Record<string, string> = {
  쿠팡: "#E94928",
  올리브영: "#3CB05A",
  무신사: "#16181D",
  "11번가": "#FF5A4D",
};
export const CAT_PLATS: Record<string, string[]> = {
  식품: ["쿠팡", "11번가"],
  "전자·IT": ["쿠팡", "11번가"],
  "패션·뷰티": ["올리브영", "무신사", "쿠팡"],
  리빙: ["쿠팡", "11번가", "올리브영"],
  스포츠: ["무신사", "쿠팡", "11번가"],
};
export const PLAT_RATE: Record<string, number> = { 쿠팡: 3.5, 올리브영: 8, 무신사: 5, "11번가": 4 };
export const PLAT_PRICE_FACTOR: Record<string, number> = { 쿠팡: 1.0, 올리브영: 1.02, 무신사: 0.98, "11번가": 1.01 };
export const PRODUCT_BASE_PRICE: Record<string, number> = {
  pr1: 4500, pr2: 189000, pr3: 219000, pr4: 13900, pr5: 599000, pr6: 1800, pr7: 32000, pr8: 79000,
};

/* ----- channel social-blade estimates ----- */
export type DummyChannelUpload = { t: string; when: string; v: string };
export type DummyChannel = {
  id: string;
  name: string;
  handle: string;
  platform: string;
  platColor: string;
  avBg: string;
  avFg: string;
  initial: string;
  subsN: number;
  subs: string;
  views: string;
  videos: string;
  grade: string;
  created: string;
  country: string;
  type: string;
  d30subsN: number;
  d30subsPct: number;
  d30viewsN: number;
  d30viewsPct: number;
  estLowN: number;
  estMonthly: string;
  estYearly: string;
  uploads: DummyChannelUpload[];
};
export const DUMMY_CHANNELS: DummyChannel[] = [
  {
    id: "ch1", name: "KT ENA 공식", handle: "@ktena_official", platform: "YouTube", platColor: "#FF0000",
    avBg: "#FDEBEA", avFg: "#D8403F", initial: "EN", subsN: 1840000, subs: "184만", views: "4.2억", videos: "3,120",
    grade: "A-", created: "2019.03", country: "대한민국", type: "엔터테인먼트",
    d30subsN: 62000, d30subsPct: 3.5, d30viewsN: 41200000, d30viewsPct: 4.6, estLowN: 18200000,
    estMonthly: "₩1,820만 ~ ₩2,910만", estYearly: "₩2.2억 ~ ₩3.5억",
    uploads: [
      { t: "[현역가왕2] 무대 직캠 풀버전", when: "2일 전", v: "21만" },
      { t: "[나는 솔로] 데이트 상대 선택", when: "4일 전", v: "32만" },
      { t: "[쯔양먹방] 12인분 클리어", when: "6일 전", v: "5.1만" },
    ],
  },
  {
    id: "ch2", name: "나는 솔로 공식", handle: "@iamsolo_official", platform: "YouTube", platColor: "#FF0000",
    avBg: "#FCE7F0", avFg: "#B23A6B", initial: "솔", subsN: 2150000, subs: "215만", views: "5.8억", videos: "1,840",
    grade: "A", created: "2021.07", country: "대한민국", type: "리얼리티",
    d30subsN: 88000, d30subsPct: 4.3, d30viewsN: 52600000, d30viewsPct: 5.1, estLowN: 23100000,
    estMonthly: "₩2,310만 ~ ₩3,640만", estYearly: "₩2.8억 ~ ₩4.4억",
    uploads: [
      { t: "데이트 상대 선택 순간", when: "1일 전", v: "32만" },
      { t: "반전 고백", when: "3일 전", v: "19.8만" },
      { t: "최종 선택 결과", when: "5일 전", v: "41만" },
    ],
  },
  {
    id: "ch3", name: "현역가왕 하이라이트", handle: "@hyunyeok_king", platform: "YouTube", platColor: "#FF0000",
    avBg: "#EDE9FE", avFg: "#6C5CE7", initial: "현", subsN: 1420000, subs: "142만", views: "3.1억", videos: "980",
    grade: "A-", created: "2023.02", country: "대한민국", type: "음악",
    d30subsN: 47000, d30subsPct: 3.4, d30viewsN: 33800000, d30viewsPct: 4.0, estLowN: 14900000,
    estMonthly: "₩1,490만 ~ ₩2,360만", estYearly: "₩1.8억 ~ ₩2.8억",
    uploads: [
      { t: "무대 직캠 풀버전", when: "2일 전", v: "21만" },
      { t: "심사위원 기립", when: "4일 전", v: "14만" },
    ],
  },
  {
    id: "ch4", name: "쯔양먹방", handle: "@tzuyang_meal", platform: "YouTube", platColor: "#FF0000",
    avBg: "#FDEBE3", avFg: "#C2603A", initial: "쯔", subsN: 964000, subs: "96.4만", views: "1.9억", videos: "1,260",
    grade: "B+", created: "2022.05", country: "대한민국", type: "음식",
    d30subsN: 31000, d30subsPct: 3.3, d30viewsN: 22400000, d30viewsPct: 3.8, estLowN: 9800000,
    estMonthly: "₩980만 ~ ₩1,560만", estYearly: "₩1.2억 ~ ₩1.9억",
    uploads: [
      { t: "12인분 클리어", when: "1일 전", v: "5.1만" },
      { t: "한입에 등극", when: "3일 전", v: "7.2만" },
    ],
  },
  {
    id: "ch5", name: "ENA 쇼퍼", handle: "@ena_shorts", platform: "TikTok", platColor: "#16181D",
    avBg: "#ECECF2", avFg: "#16181D", initial: "쇼", subsN: 735000, subs: "73.5만", views: "9,800만", videos: "2,470",
    grade: "B+", created: "2023.09", country: "대한민국", type: "쇼퍼",
    d30subsN: 24000, d30subsPct: 3.4, d30viewsN: 18900000, d30viewsPct: 6.1, estLowN: 4100000,
    estMonthly: "₩410만 ~ ₩730만", estYearly: "₩4,900만 ~ ₩8,700만",
    uploads: [
      { t: "극장골 모음 #shorts", when: "1일 전", v: "24만" },
      { t: "마지막 1초 역전", when: "2일 전", v: "18.5만" },
    ],
  },
  {
    id: "ch6", name: "KT ENA 네이버TV", handle: "tv.naver.com/ktena", platform: "네이버TV", platColor: "#03C75A",
    avBg: "#E6F0E9", avFg: "#1F8A5B", initial: "네", subsN: 518000, subs: "51.8만", views: "6,400만", videos: "1,510",
    grade: "B", created: "2020.11", country: "대한민국", type: "엔터테인먼트",
    d30subsN: 12000, d30subsPct: 2.4, d30viewsN: 9600000, d30viewsPct: 2.8, estLowN: 5200000,
    estMonthly: "₩520만 ~ ₩910만", estYearly: "₩6,200만 ~ ₩1.1억",
    uploads: [
      { t: "골 때리는 그녀들 극장골", when: "2일 전", v: "8.1만" },
      { t: "지구마불 현지 먹부림", when: "5일 전", v: "6.4만" },
    ],
  },
];

/* ----- settlement rows (settings 정산) ----- */
export type SettleRow = { name: string; color: string; smr: boolean; rpm: string; share: string; views: string; amount: string };

/* ----- studio library fallback (only when getStudioSummary is empty) ----- */
export type StudioAsset = {
  id: string; title: string; sub: string; source: "cms" | "drive"; folder: string;
  dur: string; date: string; res: string; bg: string; fg: string; initial: string;
};
export const STUDIO_ASSETS: StudioAsset[] = [
  { id: "a1", title: "나는 SOLO 22기", sub: "5회 · 리얼리티", source: "cms", folder: "solo", dur: "1:08:42", date: "2026.06.18", res: "1080p", bg: "#FCE7F0", fg: "#B23A6B", initial: "나" },
  { id: "a3", title: "강철부대W", sub: "3회 · 서바이벌", source: "cms", folder: "gangchul", dur: "58:14", date: "2026.06.20", res: "1080p", bg: "#E6F0E9", fg: "#2E7D52", initial: "강" },
  { id: "a4", title: "지구마불 시즌3", sub: "4회 · 여행", source: "cms", folder: "jigu", dur: "1:04:51", date: "2026.06.15", res: "1080p", bg: "#E3F1FB", fg: "#2A6FA8", initial: "지" },
  { id: "a5", title: "현역가왕2", sub: "7회 · 음악", source: "cms", folder: "hyun", dur: "1:22:08", date: "2026.06.17", res: "1080p", bg: "#EDE9FE", fg: "#6C5CE7", initial: "현" },
  { id: "a6", title: "쯔양먹방", sub: "5회 · 음식", source: "cms", folder: "tzu", dur: "42:30", date: "2026.06.21", res: "1080p", bg: "#FDEBE3", fg: "#C2603A", initial: "쯔" },
  { id: "a8", title: "골 때리는 그녀들 16회", sub: "미방송 · 원본", source: "drive", folder: "raw", dur: "1:30:00", date: "2026.06.10", res: "2160p", bg: "#E7F1EC", fg: "#2E7D52", initial: "골" },
];

/* ----- sample clips (fallback for the studio/clip flow without a backend) ----- */
export const SAMPLE_CLIPS: Clip[] = [
  {
    id: "sample-clip-1", rank: 1, score: 94, start: "02:14", end: "02:58", durSec: 44, startSec: 134, endSec: 178,
    caption: "이 장면 진짜 댓글 터집니다", title: "대화 흐름이 한 번에 뒤집히는 순간",
    reason: "첫 3초에 반전 포인트가 바로 나오고, 뒤이어 감정 리액션이 이어져 쇼츠 훅으로 쓰기 좋습니다.",
    labels: ["반전", "리액션", "댓글유도"],
    yt: { title: "이 장면 진짜 댓글 터집니다 #하이라이트", tags: ["쇼츠", "하이라이트", "반전"] },
    description: "긴 영상에서 바로 잘라 쓰기 좋은 하이라이트 샘플입니다.",
    publishTags: ["쇼츠", "하이라이트", "반전"],
    titleOptions: [
      { id: "sample-clip-1-t1", text: "대화 흐름이 한 번에 뒤집히는 순간", overlay: "이 장면 진짜 댓글 터집니다", note: "반전 포인트를 바로 노출합니다." },
      { id: "sample-clip-1-t2", text: "방금 표정 보고 다시 돌려봤습니다", overlay: "표정이 다 했네", note: "리액션 중심 훅입니다." },
    ],
    thumbTextOptions: [
      { id: "sample-clip-1-th1", text: "댓글 터짐", note: "참여 유도형 문구" },
      { id: "sample-clip-1-th2", text: "표정 주목", note: "장면 집중형 문구" },
    ],
  },
  {
    id: "sample-clip-2", rank: 2, score: 89, start: "06:02", end: "06:39", durSec: 37, startSec: 362, endSec: 399,
    caption: "여기서 분위기가 완전히 바뀜", title: "갑자기 모두가 조용해진 이유",
    reason: "장면 전환과 대사 밀도가 좋아 중간 이탈을 줄이기 쉬운 구간입니다.",
    labels: ["몰입", "전환", "대사"],
    yt: { title: "갑자기 모두가 조용해진 이유", tags: ["몰입", "토크", "쇼츠"] },
    description: "샘플 클립 설명입니다.",
    publishTags: ["몰입", "토크", "쇼츠"],
    titleOptions: [
      { id: "sample-clip-2-t1", text: "갑자기 모두가 조용해진 이유", overlay: "분위기 급반전", note: "긴장감을 앞에 배치합니다." },
    ],
    thumbTextOptions: [{ id: "sample-clip-2-th1", text: "급반전", note: "전환 강조" }],
  },
  {
    id: "sample-clip-3", rank: 3, score: 84, start: "11:20", end: "12:01", durSec: 41, startSec: 680, endSec: 721,
    caption: "짧게 잘라도 맥락이 살아있어요", title: "긴 영상에서 바로 쇼츠 되는 구간",
    reason: "앞뒤 설명 없이도 이해되는 독립 장면이라 바로 편집 테스트에 쓰기 좋습니다.",
    labels: ["요약", "독립장면", "입문"],
    yt: { title: "긴 영상에서 바로 쇼츠 되는 구간", tags: ["편집", "쇼츠", "요약"] },
    description: "샘플 클립 설명입니다.",
    publishTags: ["편집", "쇼츠", "요약"],
    titleOptions: [
      { id: "sample-clip-3-t1", text: "긴 영상에서 바로 쇼츠 되는 구간", overlay: "바로 써도 됨", note: "편집 완성도를 강조합니다." },
    ],
    thumbTextOptions: [{ id: "sample-clip-3-th1", text: "바로 써도 됨", note: "완성형 문구" }],
  },
];
