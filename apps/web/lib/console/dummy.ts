import type { Clip, SchedItem } from "./map";

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
  { id: "pr1", brand: "농심", product: "신라면 멀티팩", cat: "식품", prog: "쯔양먹방 · 5회", ts: "02:14", plat: "쿠팡", platColor: "#346AFF", rate: "3%", clicks: "12,400", revN: 8600000, bg: "#FDEBE3", fg: "#C2603A" },
  { id: "pr2", brand: "삼성전자", product: "갤럭시 버즈3", cat: "전자·IT", prog: "현역가왕2 · 7회", ts: "41:05", plat: "쿠팡", platColor: "#346AFF", rate: "3.5%", clicks: "8,200", revN: 14200000, bg: "#E6EAF5", fg: "#2D4FA0" },
  { id: "pr3", brand: "나이키", product: "머큐리얼 축구화", cat: "스포츠", prog: "골 때리는 그녀들 · 12회", ts: "27:33", plat: "쿠팡", platColor: "#346AFF", rate: "4%", clicks: "9,600", revN: 11800000, bg: "#ECECF2", fg: "#16181D" },
  { id: "pr4", brand: "올리브영", product: "로즈 립틴트", cat: "패션·뷰티", prog: "나는 솔로 22기 · 5회", ts: "22:07", plat: "올리브영", platColor: "#3CB05A", rate: "8%", clicks: "15,300", revN: 9600000, bg: "#E6F0E9", fg: "#1F8A5B" },
  { id: "pr5", brand: "다이슨", product: "에어랩 멀티스타일러", cat: "패션·뷰티", prog: "나는 솔로 22기 · 3회", ts: "18:42", plat: "쿠팡", platColor: "#346AFF", rate: "3.5%", clicks: "6,800", revN: 21000000, bg: "#EDE9FE", fg: "#6C5CE7" },
  { id: "pr6", brand: "코카콜라", product: "제로 350ml", cat: "식품", prog: "쯔양먹방 · 5회", ts: "05:51", plat: "쿠팡", platColor: "#346AFF", rate: "3%", clicks: "5,400", revN: 4200000, bg: "#FDEBEA", fg: "#C0392B" },
  { id: "pr7", brand: "스탠리", product: "어드벤처 텀블러", cat: "리빙", prog: "지구마불 시즌3 · 4회", ts: "33:18", plat: "11번가", platColor: "#FF5A4D", rate: "4%", clicks: "7,100", revN: 5800000, bg: "#E6F0E9", fg: "#1F7A4D" },
  { id: "pr8", brand: "무신사", product: "스탠다드 후디", cat: "패션·뷰티", prog: "강철부대W · 3회", ts: "14:29", plat: "무신사", platColor: "#16181D", rate: "5%", clicks: "4,900", revN: 6700000, bg: "#ECECF2", fg: "#16181D" },
];

export const PLATFORM_META: Record<string, string> = {
  쿠팡: "#346AFF",
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

/* ----- schedule dummy (calendar demo data, 발행/예약 mix) ----- */
const SCHED_BASE: SchedItem[] = [
  // ─── June (month=5) ── past + today: 발행 ───────────────────────────────
  { publishId:"ds-001", clipId:"dc-001", year:2026, month:5, day:2, time:"09:00", title:"[나는 솔로 22기] 첫 만남 케미 폭발 순간", status:"발행", rawStatus:"published" },
  { publishId:"ds-002", clipId:"dc-002", year:2026, month:5, day:2, time:"18:00", title:"[현역가왕2] 고음 폭발 – 심사위원 전원 기립", status:"발행", rawStatus:"published" },
  { publishId:"ds-003", clipId:"dc-003", year:2026, month:5, day:3, time:"12:00", title:"[강철부대W] 마지막 1초 역전 – 역대급 명장면", status:"발행", rawStatus:"published" },
  { publishId:"ds-004", clipId:"dc-004", year:2026, month:5, day:4, time:"09:00", title:"[쯔양먹방] 12인분 클리어 신기록", status:"발행", rawStatus:"published" },
  { publishId:"ds-005", clipId:"dc-005", year:2026, month:5, day:4, time:"21:00", title:"[지구마불 시즌3] 현지 시장 먹부림", status:"발행", rawStatus:"published" },
  { publishId:"ds-006", clipId:"dc-006", year:2026, month:5, day:5, time:"09:00", title:"[나는 솔로 22기] 반전 고백 – 모두가 울었다", status:"발행", rawStatus:"published" },
  { publishId:"ds-007", clipId:"dc-007", year:2026, month:5, day:5, time:"18:00", title:"[골 때리는 그녀들] 극장골 모음 16회", status:"발행", rawStatus:"published" },
  { publishId:"ds-008", clipId:"dc-008", year:2026, month:5, day:6, time:"12:00", title:"[한일가왕전] 한국 vs 일본 듀엣 명승부", status:"발행", rawStatus:"published" },
  { publishId:"ds-009", clipId:"dc-009", year:2026, month:5, day:7, time:"09:00", title:"[현역가왕2] 무대 직캠 – 최고 하이라이트", status:"발행", rawStatus:"published" },
  { publishId:"ds-010", clipId:"dc-010", year:2026, month:5, day:7, time:"18:00", title:"[나는 솔로 22기] 데이트 상대 최종 선택 순간", status:"발행", rawStatus:"published" },
  { publishId:"ds-011", clipId:"dc-011", year:2026, month:5, day:8, time:"09:00", title:"[강철부대W] 체력 한계 돌파 – 팀원 감동 포옹", status:"발행", rawStatus:"published" },
  { publishId:"ds-012", clipId:"dc-012", year:2026, month:5, day:9, time:"12:00", title:"[쯔양먹방] 사장님 표정이 다했습니다", status:"발행", rawStatus:"published" },
  { publishId:"ds-013", clipId:"dc-013", year:2026, month:5, day:9, time:"18:00", title:"[미스터리 수사단] 결정적 단서 공개 순간", status:"발행", rawStatus:"published" },
  { publishId:"ds-014", clipId:"dc-014", year:2026, month:5, day:10, time:"09:00", title:"[지구마불 시즌3] 숨겨진 맛집 – 현지인이 알려준 곳", status:"발행", rawStatus:"published" },
  { publishId:"ds-015", clipId:"dc-015", year:2026, month:5, day:10, time:"21:00", title:"[현역가왕2] 최후의 1인 무대 완성", status:"발행", rawStatus:"published" },
  { publishId:"ds-016", clipId:"dc-016", year:2026, month:5, day:11, time:"12:00", title:"[골 때리는 그녀들] 감독 새 역할 – 눈물의 교체", status:"발행", rawStatus:"published" },
  { publishId:"ds-017", clipId:"dc-017", year:2026, month:5, day:12, time:"09:00", title:"[나는 솔로 22기] 진심 고백 눈물 참기 챌린지", status:"발행", rawStatus:"published" },
  { publishId:"ds-018", clipId:"dc-018", year:2026, month:5, day:12, time:"18:00", title:"[한일가왕전] 결승 무대 – 관객 기립박수", status:"발행", rawStatus:"published" },
  { publishId:"ds-019", clipId:"dc-019", year:2026, month:5, day:13, time:"09:00", title:"[강철부대W] 팀워크 퍼펙트 – 역대급 기록 달성", status:"발행", rawStatus:"published" },
  { publishId:"ds-020", clipId:"dc-020", year:2026, month:5, day:14, time:"12:00", title:"[쯔양먹방] 한입에 등극 – 새 기록 탄생", status:"발행", rawStatus:"published" },
  { publishId:"ds-021", clipId:"dc-021", year:2026, month:5, day:14, time:"21:00", title:"[미스터리 수사단] 반전의 진실 – 모두가 틀렸다", status:"발행", rawStatus:"published" },
  { publishId:"ds-022", clipId:"dc-022", year:2026, month:5, day:15, time:"09:00", title:"[나는 솔로 22기] 탈락 눈물 – 진심 담은 작별", status:"발행", rawStatus:"published" },
  { publishId:"ds-023", clipId:"dc-023", year:2026, month:5, day:15, time:"18:00", title:"[지구마불 시즌3] 길 잃은 PD – 진짜 여행 시작", status:"발행", rawStatus:"published" },
  { publishId:"ds-024", clipId:"dc-024", year:2026, month:5, day:16, time:"12:00", title:"[현역가왕2] 꺾이지 않는 심장 – 감동 무대", status:"발행", rawStatus:"published" },
  { publishId:"ds-025", clipId:"dc-025", year:2026, month:5, day:17, time:"09:00", title:"[골 때리는 그녀들] 역전 대역전 – 마지막 골", status:"발행", rawStatus:"published" },
  { publishId:"ds-026", clipId:"dc-026", year:2026, month:5, day:17, time:"21:00", title:"[강철부대W] 역대급 미션 클리어 – 신기록", status:"발행", rawStatus:"published" },
  { publishId:"ds-027", clipId:"dc-027", year:2026, month:5, day:18, time:"09:00", title:"[나는 솔로 22기] 최종 선택 결과 – 충격 반전", status:"발행", rawStatus:"published" },
  { publishId:"ds-028", clipId:"dc-028", year:2026, month:5, day:18, time:"18:00", title:"[쯔양먹방] 신메뉴 도전 – 첫 반응 솔직 리뷰", status:"발행", rawStatus:"published" },
  { publishId:"ds-029", clipId:"dc-029", year:2026, month:5, day:19, time:"12:00", title:"[미스터리 수사단] 마지막 퍼즐 조각 – 진범 공개", status:"발행", rawStatus:"published" },
  { publishId:"ds-030", clipId:"dc-030", year:2026, month:5, day:20, time:"09:00", title:"[한일가왕전] 글로벌 자막 클립 – 해외 반응 폭발", status:"발행", rawStatus:"published" },
  { publishId:"ds-031", clipId:"dc-031", year:2026, month:5, day:20, time:"18:00", title:"[지구마불 시즌3] 현지인 친구 만들기 – 감동 엔딩", status:"발행", rawStatus:"published" },
  { publishId:"ds-032", clipId:"dc-032", year:2026, month:5, day:21, time:"09:00", title:"[골 때리는 그녀들] 눈물의 마지막 경기", status:"발행", rawStatus:"published" },
  { publishId:"ds-033", clipId:"dc-033", year:2026, month:5, day:22, time:"12:00", title:"[현역가왕2] 심사위원도 인정한 무대", status:"발행", rawStatus:"published" },
  { publishId:"ds-034", clipId:"dc-034", year:2026, month:5, day:22, time:"21:00", title:"[나는 솔로 22기] 짝사랑 고백 – 이 눈물 실화냐", status:"발행", rawStatus:"published" },
  { publishId:"ds-035", clipId:"dc-035", year:2026, month:5, day:23, time:"09:00", title:"[강철부대W] 강인한 정신력 – 포기 없는 도전", status:"발행", rawStatus:"published" },
  { publishId:"ds-036", clipId:"dc-036", year:2026, month:5, day:24, time:"12:00", title:"[쯔양먹방] 폭식 챌린지 – 기록이 곧 역사", status:"발행", rawStatus:"published" },
  { publishId:"ds-037", clipId:"dc-037", year:2026, month:5, day:24, time:"18:00", title:"[한일가왕전] 양국 관객 하나 된 순간", status:"발행", rawStatus:"published" },
  { publishId:"ds-038", clipId:"dc-038", year:2026, month:5, day:25, time:"09:00", title:"[지구마불 시즌3] 환율 쇼크 – 여행 예산 위기", status:"발행", rawStatus:"published" },
  { publishId:"ds-039", clipId:"dc-039", year:2026, month:5, day:25, time:"21:00", title:"[나는 솔로 22기] 선택 뒤집기 – 결말 충격", status:"발행", rawStatus:"published" },
  { publishId:"ds-040", clipId:"dc-040", year:2026, month:5, day:26, time:"09:00", title:"[현역가왕2] 전율의 피날레 – 마지막 무대", status:"발행", rawStatus:"published" },
  { publishId:"ds-041", clipId:"dc-041", year:2026, month:5, day:26, time:"18:00", title:"[골 때리는 그녀들] 페널티킥 드라마 – 승부차기", status:"발행", rawStatus:"published" },
  { publishId:"ds-042", clipId:"dc-042", year:2026, month:5, day:27, time:"12:00", title:"[강철부대W] 부상 투혼 – 팀을 위한 희생", status:"발행", rawStatus:"published" },
  { publishId:"ds-043", clipId:"dc-043", year:2026, month:5, day:28, time:"09:00", title:"[쯔양먹방] 사장도 놀란 먹방 속도", status:"발행", rawStatus:"published" },
  { publishId:"ds-044", clipId:"dc-044", year:2026, month:5, day:28, time:"18:00", title:"[나는 솔로 22기] 최종화 미리보기 – 결말 예측 불가", status:"발행", rawStatus:"published" },
  { publishId:"ds-045", clipId:"dc-045", year:2026, month:5, day:29, time:"09:00", title:"[현역가왕2] 8회 무대 직캠 – 첫 공개", status:"발행", rawStatus:"published" },
  { publishId:"ds-046", clipId:"dc-046", year:2026, month:5, day:30, time:"18:00", title:"[강철부대W] 4회 결승 미션 예고", status:"예약", rawStatus:"scheduled" },
  // ─── July (month=6) ── 예약 ───────────────────────────────────────────
  { publishId:"ds-047", clipId:"dc-047", year:2026, month:6, day:1, time:"09:00", title:"[나는 솔로 22기] 최종 커플 발표 – 결말 공개", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-048", clipId:"dc-048", year:2026, month:6, day:1, time:"18:00", title:"[현역가왕2] 8회 명장면 하이라이트 모음", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-049", clipId:"dc-049", year:2026, month:6, day:2, time:"09:00", title:"[골 때리는 그녀들] 17회 선발 라인업 공개", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-050", clipId:"dc-050", year:2026, month:6, day:2, time:"12:00", title:"[지구마불 시즌3] 5회 입국 거부 위기 순간", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-051", clipId:"dc-051", year:2026, month:6, day:3, time:"09:00", title:"[쯔양먹방] 6회 신기록 도전 – 예고 클립", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-052", clipId:"dc-052", year:2026, month:6, day:3, time:"21:00", title:"[강철부대W] 4회 최정예 선발 – 역대급 긴장감", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-053", clipId:"dc-053", year:2026, month:6, day:4, time:"09:00", title:"[한일가왕전] 4회 – 역대급 콜라보 무대 예고", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-054", clipId:"dc-054", year:2026, month:6, day:5, time:"12:00", title:"[나는 솔로 22기] 스페셜 편 – 미방송 인터뷰", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-055", clipId:"dc-055", year:2026, month:6, day:5, time:"18:00", title:"[현역가왕2] 9회 – 개인 무대 서바이벌", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-056", clipId:"dc-056", year:2026, month:6, day:6, time:"09:00", title:"[미스터리 수사단] 5회 – 새로운 용의자 등장", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-057", clipId:"dc-057", year:2026, month:6, day:7, time:"09:00", title:"[골 때리는 그녀들] 17회 전반전 – 충격 실책", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-058", clipId:"dc-058", year:2026, month:6, day:7, time:"18:00", title:"[지구마불 시즌3] 5회 – 비행기 놓친 PD", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-059", clipId:"dc-059", year:2026, month:6, day:8, time:"12:00", title:"[강철부대W] 4회 – 물리적 한계를 넘은 도전", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-060", clipId:"dc-060", year:2026, month:6, day:8, time:"21:00", title:"[쯔양먹방] 6회 – 진짜 사장님이 나타났다", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-061", clipId:"dc-061", year:2026, month:6, day:9, time:"09:00", title:"[현역가왕2] 탈락자 마지막 무대 – 눈물의 퇴장", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-062", clipId:"dc-062", year:2026, month:6, day:9, time:"18:00", title:"[나는 솔로 22기] 번외편 – 재결합 스포일러?", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-063", clipId:"dc-063", year:2026, month:6, day:10, time:"09:00", title:"[한일가왕전] 4회 – 역대급 퍼포먼스 첫 공개", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-064", clipId:"dc-064", year:2026, month:6, day:11, time:"12:00", title:"[골 때리는 그녀들] 후반전 – 드라마틱 역전골", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-065", clipId:"dc-065", year:2026, month:6, day:11, time:"18:00", title:"[강철부대W] 결승 진출 – 최후의 8인 확정", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-066", clipId:"dc-066", year:2026, month:6, day:12, time:"09:00", title:"[지구마불 시즌3] 6회 – 예산 제로 도전 시작", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-067", clipId:"dc-067", year:2026, month:6, day:12, time:"21:00", title:"[쯔양먹방] 6회 – 최종 보스 음식 등장", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-068", clipId:"dc-068", year:2026, month:6, day:13, time:"09:00", title:"[현역가왕2] 9회 명장면 – 최후의 2인 무대", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-069", clipId:"dc-069", year:2026, month:6, day:14, time:"12:00", title:"[나는 솔로 22기] 재회 스페셜 – 결말 후 이야기", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-070", clipId:"dc-070", year:2026, month:6, day:14, time:"18:00", title:"[미스터리 수사단] 5회 – 충격 반전 + 진범 공개", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-071", clipId:"dc-071", year:2026, month:6, day:15, time:"09:00", title:"[강철부대W] 결승전 – 최강자 가린다", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-072", clipId:"dc-072", year:2026, month:6, day:15, time:"21:00", title:"[한일가왕전] 결승 무대 – 역사에 남을 콜라보", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-073", clipId:"dc-073", year:2026, month:6, day:16, time:"12:00", title:"[골 때리는 그녀들] 결승전 예고 – 최강팀 격돌", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-074", clipId:"dc-074", year:2026, month:6, day:17, time:"09:00", title:"[지구마불 시즌3] 최종화 – 세계 일주 완성", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-075", clipId:"dc-075", year:2026, month:6, day:17, time:"18:00", title:"[현역가왕2] 결승 – 왕좌를 차지할 단 한 명", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-076", clipId:"dc-076", year:2026, month:6, day:18, time:"09:00", title:"[쯔양먹방] 역대급 파이널 먹방 – 한계 돌파", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-077", clipId:"dc-077", year:2026, month:6, day:19, time:"12:00", title:"[강철부대W] 최강 전사 탄생 – 역사적 순간", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-078", clipId:"dc-078", year:2026, month:6, day:19, time:"21:00", title:"[나는 솔로 22기] 커플 성사 최종 발표 다시보기", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-079", clipId:"dc-079", year:2026, month:6, day:20, time:"09:00", title:"[골 때리는 그녀들] 우승 트로피 수여 – 영광의 순간", status:"예약", rawStatus:"scheduled" },
  { publishId:"ds-080", clipId:"dc-080", year:2026, month:6, day:21, time:"18:00", title:"[한일가왕전] 시즌 총결산 – 명장면 모음", status:"예약", rawStatus:"scheduled" },
];

// ── 데모 밀도 보강: 결정적(비랜덤 → 하이드레이션 안전) 생성으로 일자별 배포 수를 약 2배로 ──
const SCHED_X_PROGRAMS = ["나는 솔로 22기", "현역가왕2", "강철부대W", "쯔양먹방", "지구마불 시즌3", "골 때리는 그녀들", "한일가왕전", "미스터리 수사단"];
const SCHED_X_TITLES = ["비하인드 미공개 컷", "댓글 반응 베스트", "역대급 리액션 다시보기", "1분 요약 하이라이트", "MZ 시청자 반응 폭발", "쇼츠 조회수 1위 클립", "라이브 채팅 발췌", "명대사 모음"];
const SCHED_X_TIMES = ["07:30", "11:00", "13:30", "15:00", "20:00", "23:00"];

function buildSchedExtra(): SchedItem[] {
  const out: SchedItem[] = [];
  let n = 81;
  const push = (month: number, day: number, k: number, status: string, raw: string) => {
    const seed = day + k * 5 + month * 7;
    out.push({
      publishId: `ds-${String(n).padStart(3, "0")}`,
      clipId: `dc-${String(n).padStart(3, "0")}`,
      year: 2026,
      month,
      day,
      time: SCHED_X_TIMES[seed % SCHED_X_TIMES.length],
      title: `[${SCHED_X_PROGRAMS[seed % SCHED_X_PROGRAMS.length]}] ${SCHED_X_TITLES[(seed + 3) % SCHED_X_TITLES.length]}`,
      status,
      rawStatus: raw,
    });
    n++;
  };
  for (let d = 2; d <= 29; d++) {
    const cnt = d % 3 === 0 ? 3 : 2;
    for (let k = 0; k < cnt; k++) push(5, d, k, "발행", "published");
  }
  for (let d = 1; d <= 21; d++) {
    const cnt = d % 2 === 0 ? 2 : 1;
    for (let k = 0; k < cnt; k++) push(6, d, k, "예약", "scheduled");
  }
  return out;
}

export const DUMMY_SCHED: SchedItem[] = [...SCHED_BASE, ...buildSchedExtra()];

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

/* ----- report screen: demo chat messages + instant replies ----- */
export type DemoChatMsg = { role: "user" | "assistant"; content: string };

export const DEMO_CHAT_MESSAGES: DemoChatMsg[] = [
  {
    role: "user",
    content: "이번 달 수익을 한 문단으로 요약해줘",
  },
  {
    role: "assistant",
    content: `이번 달 총 추정 수익은 **₩8,672만**입니다 (콘텐츠 광고 ₩482만 + 커머스 연동 ₩8,190만 합산). 전월 대비 **+32% 성장**했으며, YouTube 광고가 52%·네이버TV SMR 18% 순으로 수익을 구성합니다.

## 프로그램 TOP 3
- **나는 솔로 22기** — 조회수 130만 · 추정 수익 ₩91만
- **현역가왕2** — 조회수 92만 · 추정 수익 ₩64만
- **골 때리는 그녀들** — 조회수 88만 · 추정 수익 ₩61.6만

커머스 부문 1위는 **다이슨 에어랩** (₩2,100만), 이어 삼성 갤럭시 버즈3 (₩1,420만) 순입니다. 7월 예약 발행 35건이 순차 집행되면 성장세는 이어질 것으로 보입니다.`,
  },
  {
    role: "user",
    content: "구독자 성장률이 가장 높은 채널은?",
  },
  {
    role: "assistant",
    content: `**나는 솔로 공식 채널**이 최근 30일 기준 **+4.3% (+8.8만 명)**으로 전체 1위입니다.

## 채널별 30일 성장률

- **나는 솔로 공식**: +4.3% (+8.8만) · 등급 A
- **KT ENA 공식**: +3.5% (+6.2만) · 등급 A-
- **현역가왕 하이라이트**: +3.4% (+4.7만) · 등급 A-
- **ENA 쇼퍼 (TikTok)**: +3.4% (+2.4만) · 등급 B+
- **쯔양먹방**: +3.3% (+3.1만) · 등급 B+

**AI 인사이트:** '데이트 상대 선택 순간' 클립이 32만 뷰를 기록하며 나는 솔로 채널의 신규 구독 유입을 견인했습니다. ENA 쇼퍼 TikTok 채널의 성장률이 유튜브 메인과 근접해 크로스 포스팅 확대를 검토할 시점입니다.`,
  },
];

export const DEMO_REPLY_MAP: [string[], string][] = [
  [
    ["수익", "얼마", "요약", "한 문단"],
    `이번 달 총 추정 수익은 **₩8,672만**입니다 (콘텐츠 광고 ₩482만 + 커머스 연동 ₩8,190만 합산). 전월 대비 **+32% 성장**했으며, YouTube 광고가 52%·네이버TV SMR 18% 순으로 수익을 구성합니다.

## 프로그램 TOP 3
- **나는 솔로 22기** — 조회수 130만 · 추정 수익 ₩91만
- **현역가왕2** — 조회수 92만 · 추정 수익 ₩64만
- **골 때리는 그녀들** — 조회수 88만 · 추정 수익 ₩61.6만

커머스 1위는 **다이슨 에어랩** (₩2,100만), 이어 삼성 갤럭시 버즈3 (₩1,420만) 순입니다.`,
  ],
  [
    ["구독자", "성장", "성장률", "채널"],
    `**나는 솔로 공식 채널**이 최근 30일 기준 **+4.3% (+8.8만 명)**으로 전체 1위입니다.

## 채널별 30일 성장률

- **나는 솔로 공식**: +4.3% (+8.8만) · 등급 A
- **KT ENA 공식**: +3.5% (+6.2만) · 등급 A-
- **현역가왕 하이라이트**: +3.4% (+4.7만) · 등급 A-
- **ENA 쇼퍼 (TikTok)**: +3.4% (+2.4만) · 등급 B+
- **쯔양먹방**: +3.3% (+3.1만) · 등급 B+

**AI 인사이트:** ENA 쇼퍼 TikTok 채널의 성장률이 유튜브 메인과 근접해 크로스 포스팅 확대를 검토할 시점입니다.`,
  ],
  [
    ["쯔양", "먹방", "5회"],
    `쯔양먹방 5회 추정 수익은 **₩267,500**이며, 두 가지 경로에서 발생했습니다.

## 수익 경로 분해

**① YouTube 광고 (약 62%)**
- 발행 클립 30개 · 총 조회수 38만
- RPM ₩2,000 기준 → 약 ₩16만 추정

**② 커머스 연동 (약 38%)**
- 농심 신라면 멀티팩 (쿠팡) — 12,400 클릭 · ₩860만 기여
- 코카콜라 제로 (쿠팡) — 5,400 클릭 · ₩420만 기여

**최고 기여 클립**
- '한입에 등극' — 7.2만 뷰 · 완주율 72% · 댓글 참여 +63%
- '12인분 클리어' — 5.1만 뷰 · 재시청 급증

**추천:** 다음 회차에 대용량 밀키트 브랜드를 추가 연결하면 커머스 수익을 30~50% 더 끌어올릴 수 있습니다.`,
  ],
  [
    ["PPL", "광고주", "광고"],
    `현재 연동된 8개 브랜드의 PPL 성과를 요약합니다.

## 브랜드별 성과 TOP 5

- **다이슨** (에어랩) — 클릭 6,800 · 수수료 3.5% → **₩2,100만**
- **삼성전자** (갤럭시 버즈3) — 클릭 8,200 · 수수료 3.5% → **₩1,420만**
- **나이키** (머큐리얼) — 클릭 9,600 · 수수료 4.0% → **₩1,180만**
- **올리브영** (로즈 립틴트) — 클릭 15,300 · 수수료 8.0% → **₩960만**
- **농심** (신라면) — 클릭 12,400 · 수수료 3.0% → **₩860만**

**인사이트:** 올리브영의 수수료율(8%)이 가장 높고, 클릭수도 15,300건으로 1위입니다. 나는 솔로 22기와 뷰티 브랜드 조합이 특히 효과적입니다.

보고서 파일이 필요하다면 **"보고서 만들어줘"** 라고 입력하세요.`,
  ],
  [
    ["7월", "스케줄", "예약", "배포 계획"],
    `7월 예약 발행은 총 **35건**으로, 7월 1일부터 21일까지 순차 집행됩니다.

## 주차별 배포 계획

**1주차 (7.1~7.7) — 12건**
- 나는 솔로 22기 최종 커플 발표 외 5건
- 현역가왕2 8회 하이라이트 외 3건
- 골 때리는 그녀들 17회 외 3건

**2주차 (7.8~7.14) — 14건**
- 강철부대W 결승 진출 · 쯔양먹방 6회 · 지구마불 5회 외

**3주차 (7.15~7.21) — 9건**
- 강철부대W 최강 전사 결정 · 현역가왕2 결승 · 골때 우승 외

**최적 발행 시간:** 09:00·12:00·18:00·21:00 4개 슬롯으로 자동 분배됩니다.`,
  ],
];

export const REPORT_CHAT_RESPONSE = `PPL 광고주 제안 보고서를 생성했어요. 파일이 자동으로 다운로드됩니다.

## 보고서 포함 내용
- **Executive Summary** — KPI 4개 (발행 클립 1,863건 · 조회수 1,240만 · 수익 ₩3,840만)
- **채널 성과** — 6개 채널 구독자·성장률·추정 수익
- **프로그램별 PPL 노출** — 8개 프로그램 클립·조회수·회차 수익
- **커머스 연동 현황** — 8개 브랜드 클릭·전환·매출
- **PPL 패키지 제안** — Starter · Standard · Premium
- **7월 배포 스케줄** — 35건 예약 현황

광고주에게 직접 전달하거나 내부 검토용으로 활용하세요.`;
