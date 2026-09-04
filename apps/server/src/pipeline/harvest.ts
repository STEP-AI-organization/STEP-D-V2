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
/** 롱폼 판정 하한(초). 3분보다 짧으면 숏폼으로 쓸 구간이 안 나온다. */
export const DEFAULT_MIN_DURATION_SEC = 180;
/** 동시에 진행할 수 있는 편수. 앞 편이 분석을 마쳐야 다음을 집는다. */
export const MAX_IN_FLIGHT = 1;
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
  | "in_flight" | "daily_cap" | "stocked"
  | "no_candidate" | "insufficient_credits";

export type HarvestVerdict =
  | { pick: ChannelVideo; needCredits: number }
  | { pick: null; code: SkipCode; reason: string };

export const SKIP_REASON: Record<SkipCode, string> = {
  paused: "일시정지 상태입니다.",
  blocked: "연결되지 않은 채널이라 운영자 승인이 필요합니다.",
  in_flight: "앞 영상이 아직 처리 중입니다.",
  daily_cap: "오늘 몫을 다 채웠습니다.",
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
  /** 아직 분석이 안 끝난 편수. */
  inFlight: number;
  /** 크레딧 잔액. null 이면 이 축은 판정하지 않는다(조회 실패 시 막지 않는다). */
  creditBalance: number | null;
  /**
   * 아직 배포되지 않은 숏폼·클립 수 — **재고**.
   * 이 프로그램에 걸린 자동배포 계획이 앞으로 낼 수 있는 물량이다.
   */
  stock: number;
  /**
   * 이 프로그램의 하루 배포 물량 — **수요**. 걸린 계획들의 하루 발행 수 합.
   * 0 이면 배포할 계획이 없다는 뜻이고, 그때는 재고 판정을 하지 않는다
   * (계획을 아직 안 만든 사용자의 수집을 막으면 "등록했는데 아무 일도 안 남" 이 된다).
   */
  dailyDemand: number;
}

/**
 * 재고가 충분한가 — **분석을 더 돌릴 이유가 있는지**를 정한다.
 *
 * 수요가 0 이면(배포 계획이 없으면) 막지 않는다. 계획을 나중에 만드는 순서도 정상이고,
 * 여기서 막으면 "채널을 등록했는데 아무것도 안 생긴다" 가 된다 — 그 침묵이 더 나쁘다.
 */
export function enoughStock(stock: number, dailyDemand: number, bufferDays = STOCK_BUFFER_DAYS): boolean {
  if (!(dailyDemand > 0)) return false;
  return stock >= dailyDemand * bufferDays;
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

  if (input.inFlight >= MAX_IN_FLIGHT) {
    return { pick: null, code: "in_flight", reason: SKIP_REASON.in_flight };
  }

  const cap = source.dailyCap > 0 ? source.dailyCap : DEFAULT_DAILY_CAP;
  if (input.madeToday >= cap) {
    return { pick: null, code: "daily_cap", reason: `${SKIP_REASON.daily_cap} (하루 ${cap}편)` };
  }

  // **재고 게이트.** 배포 스케줄이 낼 몫을 이미 갖고 있으면 분석을 더 돌리지 않는다 —
  // 수천 편짜리 채널에서 이게 없으면 안 나갈 영상을 계속 만들며 크레딧만 태운다.
  if (enoughStock(input.stock, input.dailyDemand)) {
    return {
      pick: null,
      code: "stocked",
      reason: `${SKIP_REASON.stocked} (대기 ${input.stock}편 · 하루 ${input.dailyDemand}편 배포)`,
    };
  }

  const pick = candidates(input)[0];
  if (!pick) return { pick: null, code: "no_candidate", reason: SKIP_REASON.no_candidate };

  const needCredits = billableMinutes(pick.durationSec);
  if (input.creditBalance != null && input.creditBalance < needCredits) {
    return {
      pick: null,
      code: "insufficient_credits",
      reason: `${SKIP_REASON.insufficient_credits} (필요 ${needCredits} · 보유 ${input.creditBalance})`,
    };
  }

  return { pick, needCredits };
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
  const cap = input.source.dailyCap > 0 ? input.source.dailyCap : DEFAULT_DAILY_CAP;
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
  const s = String(input ?? "").trim();
  if (!s) return null;

  const id = /(?:^|channel\/)(UC[\w-]{20,})/.exec(s)?.[1];
  if (id) return { kind: "id", id };

  const handle = /(?:^|youtube\.com\/)@([\w.\-가-힣]{2,})/.exec(s)?.[1];
  if (handle) return { kind: "handle", handle };

  return null;
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
