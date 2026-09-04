/**
 * 완전자동화 — **무엇을 집을지 정하는 판정부.** DB 도 네트워크도 모른다.
 *
 * ## 이 파일이 순수한 이유
 *
 * 여기서 잘못 판단하면 **돈이 나간다.** 60분짜리 한 편이 60크레딧이고, 상한이 새면 채널
 * 하나 등록에 잔액이 통째로 사라진다. 그런 판정은 DB 를 띄우지 않고도 검증할 수 있어야 한다
 * (`harvest-pick.test.ts`). 배선은 `harvest-cycle.ts` 가 맡는다.
 *
 * ## 한 번에 한 편만 집는다
 *
 * 채널 하나에 롱폼이 300편 있을 수 있다. 그걸 한 번에 큐에 밀면
 *   · 크레딧이 순식간에 소진되고
 *   · 워커가 그 채널 하나로 막혀 다른 고객의 분석이 뒤로 밀린다.
 * 그래서 **순회당 한 편**, 그리고 **앞 편이 끝나야 다음 편**이다. 전체 소급은 "하루 상한 ×
 * 매일" 로 천천히 내려가는 것이 맞다 — 급하면 사람이 직접 넣으면 된다.
 *
 * ## 새 것부터 집는다
 *
 * 과거 300편을 먼저 처리하면, 오늘 올라온 영상이 몇 달 뒤에나 나간다. 그건 자동화가 아니라
 * 아카이브 작업이다. 그래서 **최신순**으로 집고 과거로 내려간다.
 */
import { billableMinutes } from "../billing/billing.ts";
import {
  perDayCount, rulePrograms, ruleSlots, ruleWeekdays,
  type AutomationRule, type RuleSlot,
} from "./automation.ts";

/** 하루에 몇 편까지 집을지. 60분 1편 = 60크레딧이라 이 기본값이 곧 월 청구액을 정한다. */
export const DEFAULT_DAILY_CAP = 2;
/**
 * **하루에 실제로 집히는 최대 편수 — 수집원당 1편.**
 *
 * 수확 순회는 하루 한 번(KST 02시 · `fanOutHarvestCycles` 가 날짜 dedupeKey 로 보장)이고,
 * 한 순회에서 수집원마다 **한 편만** 집는다. 그래서 `dailyCap` 을 3 으로 올려도 실제로는
 * 1편이다 — 그 사실을 코드에 적어 두지 않으면 화면이 "하루 3편 · 104일" 이라 약속하고
 * 실제로는 312일이 걸린다(사용자가 정한 수가 조용히 안 지켜지는, 이 리포 최빈 사고).
 *
 * ⚠️ **이 상한은 분석이 아니라 다운로드에도 걸린다** — 회차를 만드는 순간 다운로드(youtube.download)
 * 와 분석(content.analyze)이 한 줄로 묶여 나가기 때문이다(사용자 2026-09-04: "다운로드조차도").
 * 그래서 게이트는 **회차를 만들기 전에** 있어야 하고, 실제로 `pickNext` 가 전부 그 앞에 있다.
 */
export const MAX_PER_DAY = 1;
/** 롱폼 판정 하한(초). 3분보다 짧으면 숏폼으로 쓸 구간이 안 나온다. */
export const DEFAULT_MIN_DURATION_SEC = 180;
/** 동시에 진행할 수 있는 편수. 앞 편이 분석을 마쳐야 다음을 집는다. */
export const MAX_IN_FLIGHT = 1;
/**
 * 이만큼 지나도 분석이 안 끝났으면 **진행 중이 아니라 멈춘 것**으로 본다(기본 24시간).
 *
 * ⚠️ 이 상수가 없으면 자동화가 조용히 죽는다. 분석 완료 표시(`content_analysis` 행)는
 * **성공해야** 생기므로, 다운로드나 분석이 죽은 회차는 영원히 미완으로 남는다. 그걸
 * 진행 중으로 세면 `MAX_IN_FLIGHT=1` 에 걸려 그 수집원은 **다시는 돌지 않는다**
 * (프로덕션 실측 2026-09-04: 4일째 멈춘 미디어 하나가 수집원 하나를 통째로 세우고 있었다).
 *
 * 24시간인 이유: 60분 회차의 정상 분석이 ~19분이다(CLAUDE.md 실측). 다운로드가 밀리는
 * 최악(윈도우2가 반나절 꺼짐)을 더해도 한참 못 미치므로 **정상 파이프라인은 절대 안 걸린다.**
 *
 * 멈춘 편은 **막지 않는다.** 막으면 지금 버그와 같아진다 — 대신 사유 문구로 크게 알린다
 * (`stuckWarning`). 하루 상한이 있어 그 사이에도 하루 1편을 넘지 않는다.
 */
export const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * 채널 하나에서 볼 수 있는 업로드 수의 실질 상한.
 * 유튜브 업로드 목록이 50개 × 10페이지에서 끊긴다(`youtube.ts` fetchPlaylistItems).
 * 그보다 오래된 영상은 애초에 우리 눈에 안 들어온다 — 사람이 URL 로 직접 넣어야 한다.
 */
export const CHANNEL_VIDEO_LIMIT = 500;

export type HarvestStatus = "active" | "paused" | "blocked";

export interface HarvestSource {
  id: string;
  sourceChannelId: string;
  programId: string;
  status: HarvestStatus;
  dailyCap: number;
  minDurationSec: number;
  /** false 면 등록 시각 이후 업로드만 본다. */
  backfill: boolean;
  createdAt: number;
}

/** `channel_videos` 한 행에서 판정에 필요한 것만. */
export interface ChannelVideo {
  videoId: string;
  title: string;
  /** ISO 문자열(유튜브가 주는 그대로). */
  publishedAt: string;
  durationSec: number;
}

/**
 * 며칠치를 쟁여 둘 것인가.
 *
 * 배포 스케줄이 오늘 낼 몫을 이미 갖고 있으면 **분석을 돌리지 않는다**(사용자 결정
 * 2026-09-04). 완전자동화는 수천 편짜리 채널을 보고 있을 수 있어서, 이 게이트가 없으면
 * 배포되지도 않을 영상을 계속 분석한다 — 크레딧은 나가고 결과물은 쌓이기만 한다.
 *
 * 2일치인 이유: 하루치만 두면 렌더 실패·승인 지연 한 번에 다음 날 배포가 빈다.
 * 사흘치는 안 나갈 영상을 미리 만드는 쪽에 가깝다.
 */
export const STOCK_BUFFER_DAYS = 2;

/** 수확을 도는 시각(KST). 하루 한 번이면 충분하고, 새벽이라 분석이 낮 작업과 안 겹친다. */
export const HARVEST_HOUR_KST = 2;

/** 왜 안 집었는지 — 화면과 로그가 같은 어휘를 쓴다. */
export type SkipCode =
  | "paused" | "blocked"
  | "in_flight" | "daily_cap" | "no_plan" | "stocked"
  | "no_candidate" | "insufficient_credits";

export type HarvestVerdict =
  | { pick: ChannelVideo; needCredits: number; warning?: string }
  | { pick: null; code: SkipCode; reason: string; warning?: string };

/**
 * 멈춘 편이 있으면 그 사실을 **사람 말로**. 사유와 별개로 붙는다 — 수확은 계속 되지만
 * 앞서 만든 회차가 죽어 있다는 건 사람이 손대야 하는 상태다.
 *
 * 예전엔 4일 멈춘 것도 "앞 영상이 아직 처리 중입니다" 로 나와서 **일시적인 일로 읽혔다.**
 * 그 문구가 곧 "기다리면 된다" 는 뜻이라, 아무도 윈도우2 를 확인하지 않았다.
 */
export function stuckWarning(stuck: number): string | undefined {
  if (!(stuck > 0)) return undefined;
  const hours = Math.round(STUCK_AFTER_MS / 3_600_000);
  return `${stuck}편이 ${hours}시간 넘게 멈춰 있습니다 — 다운로드 워커(사무실 PC)가 켜져 있는지 확인하세요.`;
}

export const SKIP_REASON: Record<SkipCode, string> = {
  paused: "일시정지 상태입니다.",
  blocked: "연결되지 않은 채널이라 운영자 승인이 필요합니다.",
  in_flight: "앞 영상이 아직 처리 중입니다.",
  daily_cap: "오늘 몫을 다 채웠습니다.",
  no_plan: "배포할 곳이 없습니다 — 자동배포 계획을 먼저 만드세요.",
  stocked: "배포할 영상이 이미 충분합니다.",
  no_candidate: "새로 가져올 롱폼이 없습니다.",
  insufficient_credits: "크레딧이 모자랍니다.",
};

export interface PickInput {
  source: HarvestSource;
  /** 그 채널의 업로드(동기화된 것). 순서는 상관없다 — 여기서 정렬한다. */
  videos: ChannelVideo[];
  /** 이미 회차로 만든 videoId. **이 집합이 곧 커서다**(0054 주석). */
  alreadyMade: ReadonlySet<string>;
  /** 오늘(KST) 이 수집원이 만든 편수. */
  madeToday: number;
  /** 아직 분석이 안 끝났고 **아직 기다릴 만한** 편수(생성 후 `STUCK_AFTER_MS` 이내). */
  inFlight: number;
  /**
   * 분석이 안 끝난 채 `STUCK_AFTER_MS` 를 넘긴 편수 — **멈춘 것**.
   * 진행 중으로 세지 않는다(세면 수집원이 영영 안 돈다). 사유 문구로만 드러낸다.
   */
  stuck: number;
  /** 크레딧 잔액. null 이면 이 축은 판정하지 않는다(조회 실패 시 막지 않는다). */
  creditBalance: number | null;
  /**
   * 아직 배포되지 않은 숏폼·클립 수 — **재고**.
   * 이 프로그램에 걸린 자동배포 계획이 앞으로 낼 수 있는 물량이다.
   */
  stock: number;
  /**
   * 이 프로그램의 하루 배포 물량 — **수요**. 걸린 계획들의 하루 발행 수 합.
   * 0 이면 배포할 계획이 없다는 뜻이고, 그러면 **아무것도 집지 않는다**(아래 no_plan).
   */
  dailyDemand: number;
}

/**
 * 재고가 충분한가 — **더 가져올 이유가 있는지**를 정한다.
 *
 * 수요가 0 인 경우는 여기서 판정하지 않는다 — 그건 "재고가 충분하다" 가 아니라 "배포할 곳이
 * 없다" 는 다른 사실이고, `pickNext` 가 그 앞에서 `no_plan` 으로 멈춘다.
 */
export function enoughStock(stock: number, dailyDemand: number, bufferDays = STOCK_BUFFER_DAYS): boolean {
  if (!(dailyDemand > 0)) return false;
  return stock >= dailyDemand * bufferDays;
}

/**
 * 이 수집원이 **하루에 실제로 가져오는 편수.** 사용자가 정한 상한과 구조적 상한 중 작은 쪽.
 *
 * 화면의 예상 소요일과 순회의 실제 페이스가 **같은 함수**에서 나와야 한다. 예전엔 예상치가
 * `dailyCap` 을 그대로 나눠서, 하루 편수를 3 으로 올리면 "104일" 이라 적어 놓고 실제로는
 * 312일 걸렸다 — 화면이 지키지도 못할 약속을 하는 형태의 사고다.
 */
export function effectiveDailyCap(source: Pick<HarvestSource, "dailyCap">): number {
  const cap = source.dailyCap > 0 ? source.dailyCap : DEFAULT_DAILY_CAP;
  return Math.min(cap, MAX_PER_DAY);
}

/**
 * 지금이 수확할 시각인가(KST 기준 시).
 *
 * 하루 한 번이라 "놓치면 24시간 뒤" 가 된다. 그래서 **한 시간 창**으로 본다 —
 * 워커가 2시 정각에 정확히 깨어난다는 보장이 없다(drain 모드는 Scheduler 가 깨운다).
 */
export function isHarvestWindow(now: Date = new Date(), hour = HARVEST_HOUR_KST): boolean {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  return kst.getUTCHours() === hour;
}

/**
 * 이번 순회에 집을 영상 하나. 없으면 이유를 돌려준다.
 *
 * 순서가 곧 정책이다 — **싼 판정을 먼저** 한다(상태 → 진행 중 → 상한 → 후보 → 크레딧).
 * 크레딧 판정을 맨 뒤에 두는 이유: 후보가 정해져야 필요한 크레딧을 알 수 있다.
 */
export function pickNext(input: PickInput): HarvestVerdict {
  const { source } = input;

  if (source.status === "paused") return { pick: null, code: "paused", reason: SKIP_REASON.paused };
  if (source.status !== "active") return { pick: null, code: "blocked", reason: SKIP_REASON.blocked };

  // 멈춘 편은 **판정을 막지 않는다** — 막으면 죽은 회차 하나가 수집원을 영영 세운다
  // (STUCK_AFTER_MS 주석의 실사고). 대신 어떤 결론에도 이 경고를 함께 실어 보낸다.
  const warning = stuckWarning(input.stuck);

  if (input.inFlight >= MAX_IN_FLIGHT) {
    return { pick: null, code: "in_flight", reason: SKIP_REASON.in_flight, warning };
  }

  const cap = effectiveDailyCap(source);
  if (input.madeToday >= cap) {
    return { pick: null, code: "daily_cap", reason: `${SKIP_REASON.daily_cap} (하루 ${cap}편)`, warning };
  }

  // **배포할 곳이 없으면 아무것도 가져오지 않는다** (사용자 2026-09-04: "다 다운로드하거나
  // 그러면 안 돼 — 다운로드조차도"). 회차를 만드는 순간 다운로드와 분석이 한 줄로 묶여
  // 나가므로, 계획 없이 도는 것은 곧 **채널 전체를 하루 한 편씩 받아 두는 것**이다.
  //
  // 예전엔 여기서 막지 않았다 — "계획을 나중에 만드는 순서도 정상" 이라는 이유였는데,
  // 그 대가가 "안 나갈 영상을 무한정 받는다" 였다. 지금은 수집원을 등록할 때 계획도 같이
  // 만들어지고(POST /api/harvest/sources), 안 만든 경우엔 화면이 경고로 알린다.
  // 계획을 **멈춘** 경우도 여기로 떨어진다 — 배포를 멈췄는데 다운로드가 계속되면 안 된다.
  if (!(input.dailyDemand > 0)) {
    return { pick: null, code: "no_plan", reason: SKIP_REASON.no_plan, warning };
  }

  // **재고 게이트.** 배포 스케줄이 낼 몫을 이미 갖고 있으면 더 가져오지 않는다 —
  // 수천 편짜리 채널에서 이게 없으면 안 나갈 영상을 계속 받으며 크레딧만 태운다.
  if (enoughStock(input.stock, input.dailyDemand)) {
    return {
      pick: null,
      code: "stocked",
      reason: `${SKIP_REASON.stocked} (대기 ${input.stock}편 · 하루 ${input.dailyDemand}편 배포)`,
      warning,
    };
  }

  const pick = candidates(input)[0];
  if (!pick) return { pick: null, code: "no_candidate", reason: SKIP_REASON.no_candidate, warning };

  const needCredits = billableMinutes(pick.durationSec);
  if (input.creditBalance != null && input.creditBalance < needCredits) {
    return {
      pick: null,
      code: "insufficient_credits",
      reason: `${SKIP_REASON.insufficient_credits} (필요 ${needCredits} · 보유 ${input.creditBalance})`,
      warning,
    };
  }

  return { pick, needCredits, warning };
}

/**
 * 아직 안 만든 롱폼 — **최신순**.
 *
 * 목록·예상치 계산에도 같은 함수를 쓴다. 화면이 "312편 남음" 이라고 말한 뒤 수확기가 다른
 * 기준으로 집으면, 그 숫자는 거짓말이 된다.
 */
export function candidates(input: Pick<PickInput, "source" | "videos" | "alreadyMade">): ChannelVideo[] {
  const { source, videos, alreadyMade } = input;
  const min = source.minDurationSec > 0 ? source.minDurationSec : DEFAULT_MIN_DURATION_SEC;

  return videos
    .filter((v) => v.videoId && !alreadyMade.has(v.videoId))
    .filter((v) => Number(v.durationSec) >= min)
    // 소급을 끄면 **등록한 뒤에 올라온 것만** 본다. 등록 시점을 기준으로 삼는 이유는
    // "오늘부터 이 채널을 본다" 가 사람이 기대하는 뜻이기 때문이다.
    .filter((v) => source.backfill || publishedMs(v) >= source.createdAt)
    .sort((a, b) => publishedMs(b) - publishedMs(a));
}

/** 못 읽는 날짜는 **가장 오래된 것**으로 민다 — 순서를 모르는 값이 맨 앞에 오면 안 된다. */
function publishedMs(v: ChannelVideo): number {
  const t = Date.parse(String(v.publishedAt ?? ""));
  return Number.isFinite(t) ? t : 0;
}

export interface HarvestEstimate {
  /** 아직 안 만든 롱폼 편수. */
  remaining: number;
  /** 그걸 다 처리하는 데 드는 크레딧. */
  credits: number;
  /** 지금 상한으로 며칠 걸리는지. */
  days: number;
}

/**
 * 등록 **전에** 보여줄 숫자. "이 채널 312편 · 약 18,700크레딧 · 156일" —
 * 버튼을 누르기 전에 알아야 하는 값이다. 이걸 안 보여주면 등록 한 번에 잔액이 사라지고,
 * 사용자는 무엇이 그랬는지도 모른다.
 */
export function estimate(input: Pick<PickInput, "source" | "videos" | "alreadyMade">): HarvestEstimate {
  const list = candidates(input);
  const credits = list.reduce((sum, v) => sum + billableMinutes(v.durationSec), 0);
  // **실제 페이스**로 나눈다(effectiveDailyCap) — `dailyCap` 을 그대로 쓰면 화면이 지키지도
  // 못할 소요일을 약속한다. 재고 게이트로 더 느려질 수는 있어도 빨라지지는 않는다.
  const cap = effectiveDailyCap(input.source);
  return { remaining: list.length, credits, days: Math.ceil(list.length / cap) };
}

/** 값 검증 — 화면·API 가 같은 한계를 쓴다. 0 이나 음수를 넣어 상한을 무력화하지 못하게. */
export function clampCap(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAILY_CAP;
  return Math.min(n, 20);
}

export function clampMinDuration(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 60) return DEFAULT_MIN_DURATION_SEC;
  return Math.min(n, 3 * 3600);
}

/**
 * 유튜브 채널 주소에서 채널 식별자를 뽑는다.
 *
 * `UC…` 형태만 확실하다. `@handle`·`/c/이름` 은 **API 로 한 번 물어봐야** 채널 id 가 나오므로
 * 여기서는 "핸들이다" 까지만 판정하고, 해석은 배선부가 한다. 여기서 추측해 만들면
 * 엉뚱한 채널을 수확하게 된다.
 */
export function parseChannelRef(input: string): { kind: "id"; id: string } | { kind: "handle"; handle: string } | null {
  const s = decodeOnce(String(input ?? "").trim());
  if (!s) return null;

  const id = /(?:^|channel\/)(UC[\w-]{20,})/.exec(s)?.[1];
  if (id) return { kind: "id", id };

  // ⚠️ **핸들은 조각이 아니라 통째로 본다.** 예전엔 허용 문자만 앞에서부터 긁어서,
  //    `@하하ㅔ`(오타)가 `하하` 로 **조용히 잘렸다** — 그리고 그건 실제로 존재하는 다른
  //    채널이다(2026-09-04 프로덕션 실측). 확인하라고 만든 미리보기가 그럴듯한 오답을
  //    보여주는 최악의 형태라, 남는 글자가 있으면 **못 읽은 것으로 처리한다.**
  const seg = /(?:^|youtube\.com\/)@([^/?#\s]+)/.exec(s)?.[1];
  if (seg && /^[\w.\-가-힣]{2,}$/.test(seg)) return { kind: "handle", handle: seg };

  return null;
}

/**
 * 퍼센트 인코딩된 주소를 한 번만 되돌린다 — 브라우저 주소창에서 복사하면 한글이
 * `%ED%95%98…` 로 붙는다. 실패하면 원문 그대로 둔다(깨진 입력이 예외로 번지지 않게).
 * 한 번만 하는 이유: 여러 번 풀면 `%2520` 같은 값이 의도치 않게 경로로 바뀔 수 있다.
 */
function decodeOnce(s: string): string {
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 이 프로그램의 **배포 계획 요약** — 만든 숏폼이 어디로, 얼마나 나가는지.
 *
 * ⚠️ **`null` 은 "안 나간다" 는 뜻이다.** 계획이 없으면 수집·분석·숏폼 생성까지 다 돌고
 * 배포에서 멈춘다 — 크레딧은 그대로 나가는데 결과물이 아무 데도 안 간다. 게다가 하루 배포
 * 물량이 0 이라 **재고 브레이크도 안 걸린다**(`enoughStock` 은 수요 0 이면 false) — 상한까지
 * 매일 가져오면서 하나도 안 나가는 조합이 된다. 이 기능의 최악 상태라 화면이 크게 알린다.
 *
 * 순수 함수로 두는 이유는 이 파일의 나머지와 같다 — 화면이 읽는 숫자(하루 몇 개)가 순방의
 * 판정과 **같은 함수**(`perDayCount`)에서 나와야 하고, 그걸 DB 없이 검증할 수 있어야 한다.
 */
export interface PublishSummary {
  ruleId: string;
  channels: { accountId: string; name: string }[];
  /** 하루 몇 개 나가는지 — 걸린 계획들의 합. */
  perDay: number;
  slots: RuleSlot[];
  weekdays: number[] | null;
  templateId: string | null;
}

export function publishSummary(
  programId: string,
  rules: AutomationRule[],
  channels: { channelId: string; channelName?: string | null }[] = [],
): PublishSummary | null {
  // 멈춘 계획은 안 나가는 것과 같다 — 세면 "하루 3개 나갑니다" 라고 적어 놓고 0개가 나간다.
  const mine = rules.filter((r) => r.enabled !== false && rulePrograms(r).includes(programId));
  if (!mine.length) return null;

  const seen = new Set<string>();
  const out: { accountId: string; name: string }[] = [];
  for (const r of mine) {
    const list = r.channels?.length ? r.channels : [{ platform: r.platform, accountId: r.accountId }];
    for (const ch of list) {
      // 유튜브만 — 완전자동화는 유튜브 → 유튜브다. 다른 플랫폼 계획이 같은 프로그램에
      // 붙어 있어도 이 화면이 그걸 자기 배포처인 양 말하면 안 된다.
      if (ch.platform !== "youtube" || !ch.accountId || seen.has(ch.accountId)) continue;
      seen.add(ch.accountId);
      const known = channels.find((x) => x.channelId === ch.accountId);
      out.push({ accountId: ch.accountId, name: known?.channelName || ch.accountId });
    }
  }

  const first = mine[0];
  return {
    ruleId: first.id,
    channels: out,
    perDay: mine.reduce((sum, r) => sum + perDayCount(r), 0),
    slots: ruleSlots(first),
    weekdays: ruleWeekdays(first),
    templateId: first.templateId ?? null,
  };
}
