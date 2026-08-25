/**
 * 채널별 업로드 규칙 (FLOWS F4-2 · README §10). 순수 모듈.
 *
 * "채널마다 규칙이 다르고, 규칙은 선택 즉시 폼에 반영된다."
 *
 * 여기서 제일 중요한 건 **못 보내는 이유를 말해 주는 것**이다. 채널을 그냥 비활성으로
 * 두면 사용자는 왜 안 되는지 몰라서 다른 데를 찾아 헤맨다. 그래서 판정이 boolean 이 아니라
 * `{ ok, reason }` 이다.
 */

/** 채널 역할 (README §10). 표시용 + 기본 규칙의 출발점. */
export const CHANNEL_ROLES = ["main", "sub", "shorts_only", "affiliate"] as const;
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export const CHANNEL_ROLE_LABEL: Record<ChannelRole, string> = {
  main: "본채널",
  sub: "서브채널",
  shorts_only: "숏폼 전용",
  affiliate: "계열 채널",
};

export type FrameAspect = "9:16" | "16:9" | "any";

export interface ChannelRule {
  platform: string;
  /** 연결 계정 식별자 (YouTube channelId · Meta page id …). */
  accountId: string;
  label: string;
  role: ChannelRole;
  /** 길이 상한(초). null = 제한 없음. */
  maxSec: number | null;
  /** 허용 프레임. "any" 면 둘 다. */
  aspect: FrameAspect;
  titlePrefix: string;
  /** `#태그 #태그` 형태의 템플릿. `{program}`·{episode} 치환. */
  hashtagTemplate: string;
  tonePreset: string;
  privacy: "public" | "unlisted" | "private";
  /**
   * 공개 유예(분) — 자동 게시를 이만큼 **비공개로 잡아뒀다 공개**한다. 0 = 즉시(종전 동작).
   *
   * 유튜브 `status.publishAt` 예약으로 구현한다(유튜브가 private 로 들고 있다가 스스로
   * 공개 — 우리가 나중에 공개 API 를 부르는 방식은 워커가 죽으면 영원히 비공개로 남는다).
   * 값의 근거는 "알고리즘이 영상을 이해할 시간"이 아니라 **처리 완료**다: 업로드 직후엔
   * HD 트랜스코딩이 안 끝났고(초기 시청자가 360p 를 본다) 커스텀 썸네일도 업로드 뒤에 붙는다.
   * ⚠️ privacy 가 public 일 때만 적용된다 — publishAt 은 결국 공개로 끝나므로, unlisted·
   * private 목표에 걸면 의도한 공개 범위를 바꿔 버린다.
   */
  publishDelayMin: number;
  /** 예약 시간대 (예: "평일 19:00" · 자유 문자열). 비면 예약 기본값 없음. */
  scheduleWindow: string;
  enabled: boolean;
}

/** 공개 유예 기본값(분). 쇼츠(60초 내외)의 HD 처리는 대개 이 안에 끝난다. */
export const DEFAULT_PUBLISH_DELAY_MIN = 5;

/**
 * 예약은 **5분 단위**로만 잡는다 (사용자 2026-08-20: "13분·12분은 안 되고 10분·15분이어야 함").
 * 유튜브 예약이 5분 격자를 벗어난 시각을 거부·보정하는 사례가 있어, 우리 쪽에서 먼저 맞춘다.
 * 격자에 맞추는 비용은 몇 분 더 기다리는 것뿐이라, 어긋나서 예약이 깨지는 것보다 싸다.
 */
export const PUBLISH_SLOT_MIN = 5;

/**
 * 저장·수신값 → 유효한 유예(분). 음수·비수치는 기본값, 과대는 상한(6시간).
 * 0 은 **살린다** — "즉시 공개" 라는 뜻이 있는 값이라 기본값으로 되돌리면 유예를 끌 수 없다.
 * 양수는 5분 격자로 **올림**한다(내림하면 사용자가 정한 유예보다 짧아진다).
 */
export function normalizePublishDelayMin(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PUBLISH_DELAY_MIN;
  if (n === 0) return 0;
  return Math.min(360, Math.ceil(n / PUBLISH_SLOT_MIN) * PUBLISH_SLOT_MIN);
}

/**
 * 예약 시각을 다음 5분 경계로 **올림**한다 (초·밀리초는 0).
 *
 * 유예가 5분이어도 지금이 15:31:10 이면 목표는 15:36:10 이라 격자를 벗어난다 → 15:40 으로 올린다.
 * 항상 올림이라 **실제 유예는 설정값 이상**이 된다(짧아지는 쪽으로는 절대 안 간다).
 */
export function nextPublishSlot(atMs: number): Date {
  const slot = PUBLISH_SLOT_MIN * 60_000;
  return new Date(Math.ceil(atMs / slot) * slot);
}

/** 역할별 기본 규칙 — 새 채널을 붙일 때의 출발점이지 강제가 아니다. */
export function defaultRuleFor(role: ChannelRole, platform: string): Omit<ChannelRule, "accountId" | "label" | "platform"> {
  const base = {
    role,
    titlePrefix: "",
    hashtagTemplate: "",
    tonePreset: "기본",
    privacy: "public" as const,
    publishDelayMin: DEFAULT_PUBLISH_DELAY_MIN,
    scheduleWindow: "",
    enabled: true,
  };
  if (role === "shorts_only") return { ...base, maxSec: platform === "youtube" ? 60 : 90, aspect: "9:16" };
  // 네이버 TV 는 가로 VOD. 3분은 클립 길이 관행이지 하드 상한은 아니다.
  if (platform === "navertv") return { ...base, maxSec: 180, aspect: "16:9" };
  // 네이버 클립은 세로 숏폼 전용이다 — 가로 영상을 올리면 스튜디오가 거부한다.
  if (platform === "naverclip") return { ...base, maxSec: 90, aspect: "9:16" };
  return { ...base, maxSec: null, aspect: "any" };
}

// ── 숏폼(세로) 길이 하드 상한 ────────────────────────────────────────────────────
//
// 2026-08-25 사고: 자동배포가 **3분(180초)이 넘는 구간을 "숏폼" 으로 렌더·게시**했다.
// 원인은 두 겹이었다.
//   (1) core 의 beat-only 추천 경로에 길이 상한이 프롬프트 문구뿐이었다(결정론 코드 없음).
//   (2) factory·automation-cycle 이 `/api/clips/:id/export` 를 **채널 없이** 불렀다 →
//       index.ts `resolveRenderPreset` 이 null → 렌더 프리셋의 maxSec 캡(`capped`)이
//       아예 발동하지 않아 원본 구간 길이 그대로 인코딩됐다.
// (1)은 core 에서 고쳤고, 여기는 (2)를 위한 순수 어휘다. **무인 경로는 반드시** 대상 채널의
// 프리셋 키를 넘겨서 렌더가 상한을 강제하게 한다.

/**
 * 숏폼이라고 부를 수 있는 절대 상한(초) — core/recommend/recommend.py `MAX_SHORT_SEC` 의
 * 서버 미러. 배포처별 상한(아래 `SHORTS_RENDER_PRESETS`)과는 **다른 축**이다:
 *   · SHORTFORM_MAX_SEC = "이게 숏폼인가"   (물건의 정의 · 채택 단계에서 본다)
 *   · 배포처 maxSec      = "이 배포처가 받는가" (배달 규격 · 렌더 단계에서 자른다)
 * 둘을 하나로 합치면 안 된다. 합치면 90초 숏폼을 60초 배포처 때문에 채택조차 못 하거나(과잉),
 * 15분 롱폼을 60초로 잘라 "숏폼" 이라며 내보내게 된다(파괴). 그래서 두 자리에서 각각 본다.
 */
export const SHORTFORM_MAX_SEC = 90;

/**
 * 플랫폼 → 세로(숏폼) 렌더 프리셋 키. **index.ts `RENDER_PRESETS` 의 부분 미러**이고
 * `shortform-cap.test.ts` 가 두 표의 maxSec 일치를 강제한다(한쪽만 고치면 테스트가 깨진다).
 * 여기 없는 플랫폼(tiktok·naverclip·facebook)은 렌더 프리셋 자체가 없어 null 이 된다 —
 * 그쪽은 SHORTFORM_MAX_SEC 채택 게이트가 유일한 방어선이다.
 */
export const SHORTS_RENDER_PRESETS: Record<string, { key: string; maxSec: number }> = {
  youtube: { key: "youtube_shorts", maxSec: 60 },
  instagram: { key: "instagram_reels", maxSec: 90 },
};

/** 세로(숏폼) 프레임인가. `frameOf` 와 같은 어휘("9:16-crop-main" 등)를 받는다. */
export function isVerticalAspect(aspectRatio: unknown): boolean {
  return frameOf(aspectRatio) === "9:16";
}

/**
 * 무인 렌더가 `/clips/:id/export` 에 넘길 채널 프리셋 키. 없으면 null(= 프리셋 없음 · 종전 동작).
 *
 * 계획 하나가 배포처를 여럿 갖고 있으면 **가장 빡빡한 상한**을 고른다 — 렌더는 클립당 한 번이고
 * (`/export` 의 revision 캐시), 60초 배포처와 90초 배포처를 동시에 만족하는 길이는 60초뿐이다.
 * 가로(16:9)는 null 이다: 롱폼은 배포처 길이 규격이 아니라 편성 판단의 대상이고, 여기서 자르면
 * 15분 클립이 60초 조각이 된다.
 */
export function autoRenderChannel(platforms: readonly string[], aspectRatio: unknown): string | null {
  if (!isVerticalAspect(aspectRatio)) return null;
  let best: { key: string; maxSec: number } | null = null;
  for (const p of platforms) {
    const preset = SHORTS_RENDER_PRESETS[String(p ?? "").trim().toLowerCase()];
    if (!preset) continue;
    if (!best || preset.maxSec < best.maxSec) best = preset;
  }
  return best?.key ?? null;
}

/**
 * 이 구간을 **세로 숏폼으로 채택해도 되는가** — 무인 경로(factory·자동배포) 전용 게이트.
 *
 * 렌더 캡이 있으니 채택은 그냥 해도 되지 않나? 아니다. 3분짜리 구간을 세로로 채택하면 렌더가
 * 60초에서 자르는데, 그 결과물은 숏폼이 아니라 **머리만 남은 롱폼**이다. 사람이 없는 경로에서는
 * 잘라 내보내는 것보다 안 만드는 게 옳다 — 사람이 편집기에서 직접 고르는 길은 그대로 열려 있다.
 * 가로(16:9) 채택에는 걸리지 않는다(롱폼은 원래 길다).
 */
export function shortformSegmentTooLong(aspectRatio: unknown, segmentSec: unknown): boolean {
  if (!isVerticalAspect(aspectRatio)) return false;
  const n = Number(segmentSec);
  return Number.isFinite(n) && n > SHORTFORM_MAX_SEC;
}

/**
 * 렌더 창을 배포처 상한 안으로 자른다 — `/api/clips/:id/export` 의 길이 캡 본체.
 *
 * 라우트 안에 인라인으로 있던 세 줄을 **순수 함수로 뽑았다**(동작 동일). 이 리포에서 가장
 * 비싼 사고가 "3분짜리가 숏폼으로 나갔다" 였는데, 정작 그걸 막는 산수는 테스트가 한 줄도
 * 없었다 — 라우트 안에 있어서 DB 없이는 부를 수가 없었기 때문이다.
 *
 * ⚠️ 상한은 **출력 길이**에 건다. 배속(2× 빠르게)이면 같은 60초 출력에 120초 구간이 필요하고,
 * 반대로 0.5× 느리게면 60초 출력이 30초 구간이다. 구간 길이에 그냥 걸면 느린 클립이
 * 유튜브 60초 상한을 넘겨 버린다.
 *
 * `capped` 는 null 이 아니면 "요청보다 짧게 나갔다" 는 뜻이다 — 조용히 자르지 않고 돌려준다.
 */
export function capRenderWindow(
  maxSec: number | null | undefined,
  renderStart: number,
  renderEnd: number,
  speed = 1,
): { renderEnd: number; capped: { maxSec: number; requestedSec: number } | null } {
  const spd = Number.isFinite(speed) && Number(speed) > 0 ? Number(speed) : 1;
  const cap = Number(maxSec);
  if (!Number.isFinite(cap) || cap <= 0) return { renderEnd, capped: null };
  const outSec = (renderEnd - renderStart) / spd;
  if (!(outSec > cap)) return { renderEnd, capped: null };
  return {
    // 이만큼의 구간이 정확히 maxSec 짜리 출력이 된다.
    renderEnd: renderStart + cap * spd,
    capped: { maxSec: cap, requestedSec: Number(outSec.toFixed(2)) },
  };
}

export interface MediaFacts {
  id: string;
  durationSec: number;
  /** 클립의 프레임. "9:16-crop-main" 같은 에디터 어휘도 받는다. */
  aspectRatio?: string | null;
  rendered?: boolean;
}

export interface Eligibility {
  ok: boolean;
  /** 못 보내는 이유. ok 면 빈 문자열. */
  reason: string;
  code: "" | "disabled" | "too_long" | "aspect" | "shorts_only" | "not_rendered";
}

/** "9:16-crop-main" → "9:16". 모르면 null. */
export function frameOf(aspectRatio: unknown): "9:16" | "16:9" | null {
  const s = String(aspectRatio ?? "");
  if (s.startsWith("9:16")) return "9:16";
  if (s.startsWith("16:9")) return "16:9";
  return null;
}

/** 숏폼인가 — 세로 프레임이면 숏폼으로 본다. */
export function isShortForm(media: MediaFacts): boolean {
  return frameOf(media.aspectRatio) === "9:16";
}

/**
 * 이 미디어를 이 채널로 보낼 수 있는가 (F4-2).
 *
 * 순서가 중요하다: 사용자가 **가장 먼저 고쳐야 할 이유**를 하나만 보여 준다.
 * 이유를 여러 개 늘어놓으면 어디부터 손대야 할지 모른다.
 */
export function eligibility(rule: ChannelRule, media: MediaFacts): Eligibility {
  if (!rule.enabled) {
    return { ok: false, code: "disabled", reason: "이 채널은 사용 중지 상태입니다." };
  }
  if (media.rendered === false) {
    return { ok: false, code: "not_rendered", reason: "렌더가 끝나지 않았습니다 — 내보내기 후 보낼 수 있습니다." };
  }

  const frame = frameOf(media.aspectRatio);

  // 숏폼 전용 채널에는 클립(가로)을 보낼 수 없다 (F4-2).
  if (rule.role === "shorts_only" && frame === "16:9") {
    return {
      ok: false,
      code: "shorts_only",
      reason: `${rule.label} 은(는) 숏폼 전용입니다 — 가로(16:9) 클립은 보낼 수 없습니다.`,
    };
  }

  if (rule.aspect !== "any" && frame && frame !== rule.aspect) {
    return {
      ok: false,
      code: "aspect",
      reason: `${rule.label} 은(는) ${rule.aspect} 만 받습니다 (이 미디어는 ${frame}).`,
    };
  }

  if (rule.maxSec != null && media.durationSec > rule.maxSec) {
    const over = Math.ceil(media.durationSec - rule.maxSec);
    return {
      ok: false,
      code: "too_long",
      reason: `길이 상한 ${rule.maxSec}초를 ${over}초 초과합니다 — 편집기에서 줄여야 합니다.`,
    };
  }

  return { ok: true, code: "", reason: "" };
}

/** 여러 미디어를 한 채널에 보낼 때 — 하나라도 막히면 그 사유를 모은다. */
export function eligibilityForAll(rule: ChannelRule, medias: MediaFacts[]): {
  ok: boolean;
  blocked: { media: MediaFacts; why: Eligibility }[];
} {
  const blocked = medias
    .map((m) => ({ media: m, why: eligibility(rule, m) }))
    .filter((x) => !x.why.ok);
  return { ok: blocked.length === 0, blocked };
}

/**
 * 규칙을 제목·해시태그에 적용한다 (F4-2 "선택 즉시 폼에 반영").
 * 접두사가 이미 붙어 있으면 두 번 붙이지 않는다 — 채널을 바꿔 가며 고르다 보면
 * `[예능][예능] 제목` 같은 게 나온다.
 */
export function applyRule(
  rule: ChannelRule,
  input: { title: string; program?: string; episode?: string | number },
): { title: string; hashtags: string } {
  const prefix = rule.titlePrefix.trim();
  const raw = input.title.trim();
  const title = !prefix ? raw : raw.startsWith(prefix) ? raw : `${prefix} ${raw}`.trim();

  const hashtags = rule.hashtagTemplate
    .replace(/\{program\}/g, String(input.program ?? "").replace(/\s+/g, ""))
    .replace(/\{episode\}/g, String(input.episode ?? ""))
    .trim();

  return { title, hashtags };
}

export function isChannelRole(v: unknown): v is ChannelRole {
  return typeof v === "string" && (CHANNEL_ROLES as readonly string[]).includes(v);
}
