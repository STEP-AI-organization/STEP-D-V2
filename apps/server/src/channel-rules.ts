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
  /** 예약 시간대 (예: "평일 19:00" · 자유 문자열). 비면 예약 기본값 없음. */
  scheduleWindow: string;
  enabled: boolean;
}

/** 역할별 기본 규칙 — 새 채널을 붙일 때의 출발점이지 강제가 아니다. */
export function defaultRuleFor(role: ChannelRole, platform: string): Omit<ChannelRule, "accountId" | "label" | "platform"> {
  const base = {
    role,
    titlePrefix: "",
    hashtagTemplate: "",
    tonePreset: "기본",
    privacy: "public" as const,
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
