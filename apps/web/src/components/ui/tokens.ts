/**
 * 화면 언어의 조합 — **여기서만 가져다 쓴다.**
 *
 * ## 왜 만들었나
 *
 * 색 변수(`--color-*`)는 원래 한 곳(globals.css)에 있었는데도 어긋남이 계속 났다.
 * 2026-09-11 하루에만 네 번:
 *   · `BillingDialog` 껍데기가 옛 시스템(`sd-modal`·`--sd-card`)
 *   · 다이얼로그 7개가 옛 시스템
 *   · 다이얼로그 폭이 어림수라 원본과 8~64px 어긋남
 *   · 새로 만든 카드 폼이 shadcn 토큰(`bg-background`·`ring-ring`)
 *
 * **변수가 흩어진 게 아니라 "조합" 이 흩어진 것**이 원인이었다. 같은 알약 버튼이 파일마다
 * 복사돼 있고, 폭 숫자는 각자 적었다. 그래서 조합을 여기 모은다.
 *
 * ## 무엇을 모으고 무엇을 안 모으나
 *
 * **값이 같은데 여러 곳에 복사된 것만** 모은다. 자리마다 다른 건 그대로 둔다 —
 * 디자이너는 실제로 자리마다 다른 크기를 쓰고(목록 칩 `h-6 px-3` vs 모달 푸터 `px-5 py-2.5`),
 * 그걸 하나로 뭉개면 원본에서 멀어진다. 통일이 목적이 아니라 **중복 제거**가 목적이다.
 *
 * 새 조합을 넣기 전에 물을 것: "이게 원본의 여러 자리에서 같은 값으로 반복되나?"
 * 한 자리에서만 쓰는 값은 그 파일에 두는 게 낫다.
 */

// ── 다이얼로그 폭 ──────────────────────────────────────────────────────────────
//
// 원본은 Tailwind 클래스(`max-w-lg`)로 잡는데 우리 `BillingDialog` 는 style maxWidth(px)로
// 받는다. 어림수(440·520·640)를 쓰면 모달마다 8~64px 어긋난다 — 실제로 그래서
// "가로 너비가 약간 다르다" 는 지적이 나왔다(2026-09-07).
/** Tailwind `max-w-*` 등가 px. 새 다이얼로그는 **이 넷 중에서** 고른다. */
export const MODAL_W = {
  /** `max-w-md` — 설정처럼 입력 몇 개짜리 */
  md: 448,
  /** `max-w-lg` — 기본. 결제 수단 등 */
  lg: 512,
  /** `max-w-xl` — 목록이 들어가는 창(크레딧 내역) */
  xl: 576,
  /** `max-w-2xl` — 표가 들어가는 창(인보이스) */
  "2xl": 672,
} as const;

// ── 알약 버튼 (모달 푸터 · 본문 액션) ──────────────────────────────────────────
//
// 원본 credits MODAL 1 의 푸터 알약. 결제 화면 전반이 이 언어다.

const PILL_BASE = "px-5 py-2.5 rounded-full text-xs cursor-pointer transition-colors"
  + " disabled:opacity-60 disabled:cursor-not-allowed";

/** 중립 — 취소·변경처럼 되돌릴 수 있는 행동. */
export const PILL = `${PILL_BASE} border border-[var(--color-border-subtle)]`
  + " bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)]"
  + " text-[var(--color-text-primary)] font-semibold";

/** 강조 — 그 창의 마지막 행동 하나. 그림자까지가 원본이다. */
export const PILL_PRIMARY = `${PILL_BASE} bg-[#1C60FF] hover:bg-[#0D1EB8] text-white`
  + " font-bold border-none shadow-md shadow-[#1C60FF]/25";

/** 파괴적 — 삭제·해지. 배경이 아니라 **테두리**로 경고한다(원본). */
export const PILL_DANGER = `${PILL_BASE} bg-white dark:bg-slate-900 hover:bg-rose-500/10`
  + " text-rose-600 dark:text-rose-400 font-bold border border-rose-500/30";

/** 알약 입력 — 폼 필드. `PILL` 과 높이를 맞춘다. */
export const PILL_INPUT =
  "w-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] px-4 py-2.5"
  + " rounded-full text-xs font-semibold text-[var(--color-text-primary)]"
  + " placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[#1C60FF] shadow-none";

// ── 작은 버튼 (목록 행 · 카드 안 액션) ─────────────────────────────────────────
//
// `publish-channels` 와 `coupang-account` 에 **글자 그대로 같은 값**이 두 벌 있었다.

const SMALL_BASE = "px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer shadow-none"
  + " disabled:opacity-50 disabled:cursor-not-allowed";

/** 중립 작은 버튼. */
export const BTN = `${SMALL_BASE} bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)]`
  + " text-[var(--color-text-primary)] border border-[var(--color-border-subtle)]";

/** 삭제 작은 버튼 — 평소엔 중립이고 hover 에서만 붉어진다(실수 클릭 방지). */
export const BTN_DEL = `${SMALL_BASE} bg-[var(--color-bg-card)] text-[var(--color-text-primary)]`
  + " border border-[var(--color-border-subtle)] transition-colors"
  + " hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200"
  + " dark:hover:bg-rose-950/60 dark:hover:text-rose-400 dark:hover:border-rose-900";

/** 강조 작은 버튼 — 연동·추가처럼 그 카드의 주 행동. */
export const BTN_PRIMARY = "px-3.5 py-2 rounded-full bg-[#222222] hover:bg-black text-white"
  + " dark:bg-stone-700 dark:hover:bg-stone-600 text-xs font-bold transition-colors"
  + " cursor-pointer shadow-none border-none disabled:opacity-50 disabled:cursor-not-allowed";
