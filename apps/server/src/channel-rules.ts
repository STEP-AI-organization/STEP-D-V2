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

/**
 * 공개 유예 기본값(분). **0 = 다이렉트 배포** — 업로드 즉시 공개(2026-08-25 사용자 결정).
 * 트레이드오프: 업로드 직후 몇 분은 HD 트랜스코딩 전이라 초기 시청자가 SD 를 볼 수 있다 —
 * 그게 싫은 채널은 채널 규칙에서 유예(분)를 직접 넣으면 된다(옵트인, 5분 격자).
 */
export const DEFAULT_PUBLISH_DELAY_MIN = 0;

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
