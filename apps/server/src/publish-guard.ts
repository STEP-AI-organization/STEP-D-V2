/**
 * 배포 진입 판정 — **모든 배포 경로가 공유하는 단 하나의 관문.**
 *
 * FLOWS F3 Invariant (FLOWS.md:73): "게이트를 통과하지 않은 미디어는 **어떤 경로로도**
 * 게시되지 않는다." 지금 배포 진입점이 4곳이고 각자 다르게 판정한다 —
 *
 *   POST /api/distributions/publish   env 킬스위치 + isClipRendered
 *   POST /api/distributions/retry     env 킬스위치만
 *   worker distribution.publish       env 킬스위치 + mediaId 유무
 *   factory publishing                아무것도 안 봄  ← 라우트를 우회해 큐에 직접 넣는다
 *
 * 판정이 네 벌로 갈려 있는 한, 라우트 한 곳에 게이트를 붙여도 다른 경로로 새어 나간다.
 * 그래서 판정을 여기로 모으고, 아래 아키텍처 테스트(publish-guard.test.ts)로
 * "큐에 넣는 지점이 한 곳뿐"임을 소스 스캔으로 강제한다.
 *
 * ⚠️ 이 모듈은 **순수하다.** DB·네트워크·env 를 읽지 않는다. index.ts 는 6000줄에
 * top-level `serve()` 가 있어 import 자체가 불가능하고, 그 안에 있는 판정 로직은
 * 추출하지 않으면 원천적으로 테스트할 수 없다. 라우트는 index.ts 에 그대로 둔다
 * (CLAUDE.md 규칙) — 순수 헬퍼만 여기로 옮긴다.
 */

/** 배포 대상이 될 수 있는 채널. */
export type PublishChannel =
  | "youtube" | "instagram" | "facebook" | "tiktok" | "navertv" | "naverclip" | (string & {});

/**
 * 실제로 받는 채널의 전체 목록. channelPublishMode 가 "모르는 값 = record" 로 처리하므로,
 * 이 목록으로 먼저 거르지 않으면 오타·폐기된 채널명("meta" 등)이 **조용히 record 로
 * 수락**되어 존재하지 않는 채널에 '기록됨'이 쌓인다.
 */
export const PUBLISH_CHANNELS = new Set<string>([
  "youtube", "instagram", "facebook", "tiktok", "navertv", "naverclip",
]);
export function isPublishChannel(channel: string): boolean {
  return PUBLISH_CHANNELS.has(channel);
}

/**
 * 네이버 채널 id → 워커가 쓰는 target.
 *
 * 채널 id 를 두 개로 나눈 이유: 네이버 TV(가로 VOD)와 네이버 클립(세로 숏폼)은 **올리는
 * 스튜디오도 폼도 다르다.** 하나로 묶으면 배포 기록에서 어느 쪽에 올라갔는지 알 수 없고,
 * 워커도 target 을 추측해야 한다 — "클립에 올린 줄 알았는데 TV 에 올라간" 실패가 제일 나쁘다.
 */
export const NAVER_CHANNELS = { navertv: "tv", naverclip: "clip" } as const;
export type NaverChannelId = keyof typeof NAVER_CHANNELS;
export function isNaverChannel(channel: string): channel is NaverChannelId {
  return channel in NAVER_CHANNELS;
}

/**
 * 채널이 실제로 파일을 올리는가, 기록만 남기는가 (FLOWS.md:86-87).
 *
 * YouTube 와 **네이버 TV·클립**이 실업로드다. 네이버는 공개 API 가 없어 브라우저 자동화로
 * 올리지만, 파일이 실제로 올라간다는 점에서 YouTube 와 같은 축이다(2026-08-11 실발행 확인).
 * TikTok·Instagram·Facebook 은 게이트에 달렸다: 각 *_UPLOAD_ENABLED ON + 계정 지정이면
 * 실업로드(IG 릴·FB 릴·TikTok 드래프트), OFF 면 기록만. env 는 여기서 읽지 않는다(모듈
 * 순수성 — 상단 주석) — 게이트 판정은 호출부(publish-dispatch)가 upload-gate 에서 읽어 opts 로 넘긴다.
 * 게이트 OFF 인 Meta 는 "실제 게시는 담당자가 해당 앱에서 직접" 하고 우리는 기록만 남긴다.
 *
 * **이 구분이 사라지면 F4 Invariant(FLOWS.md:92)가 깨진다** —
 * 올라가지도 않은 것을 '게시됨'으로 보여주게 된다.
 */
export function channelPublishMode(
  channel: PublishChannel,
  opts?: { tiktokUpload?: boolean; instagramUpload?: boolean; facebookUpload?: boolean },
): "upload" | "record" {
  if (channel === "youtube" || isNaverChannel(channel)) return "upload";
  if (channel === "tiktok" && opts?.tiktokUpload) return "upload";
  if (channel === "instagram" && opts?.instagramUpload) return "upload";
  if (channel === "facebook" && opts?.facebookUpload) return "upload";
  return "record";
}

/** 배포 상태값. `recorded`(기록됨)는 `published`(게시됨)와 **절대** 같은 값이 아니다. */
export type DistributionStatus =
  | "none" | "pending" | "scheduled" | "published" | "recorded" | "failed";

/**
 * 이 채널·이 예약여부에서 배포가 처음 갖는 상태.
 *
 * FLOWS.md:92 "`기록됨`을 `게시됨`처럼 보여주지 않는다" — 그래서 `published` 는
 * **upload 모드에서만** 나올 수 있고, record 모드는 예약이든 아니든 `recorded` 다.
 * (upload 모드의 `published` 는 실제 업로드가 끝난 뒤 워커가 쓴다. 여기서는 `pending`.)
 */
export function distributionStatusFor(
  mode: "upload" | "record",
  scheduled: boolean,
): DistributionStatus {
  if (mode === "record") return "recorded";
  return scheduled ? "scheduled" : "pending";
}

/**
 * 렌더가 끝나 배포에 쓸 수 있는 클립인가.
 *
 * 배포는 **최종 렌더**를 소비한다(초안이 아니라). 채택만 하고 export 안 한 클립은
 * 건너뛰고, 건너뛴 사실을 호출부가 사용자에게 알려야 한다.
 */
export function isClipRendered(clip: {
  rendered?: boolean; mediaId?: unknown; status?: string;
}): boolean {
  return clip.rendered === true || Boolean(clip.mediaId) || clip.status === "published";
}

/**
 * 배포 항목의 계정 정체성 — 같은 플랫폼 다계정을 가르는 열쇠.
 * YouTube=youtubeChannelId · 네이버=naverAccountId · TikTok=tiktokOpenId ·
 * Instagram=igUserId · Facebook=metaPageId. 전부 없으면 null(계정 개념 이전의 레거시 행).
 * ⚠️ 새 계정형 채널을 추가하면 여기에도 넣어야 upsert 가 계정별로 매칭하고 retry 가 계정을 재사용한다.
 */
export function distributionAccountId(
  d: {
    youtubeChannelId?: unknown; naverAccountId?: unknown; tiktokOpenId?: unknown;
    igUserId?: unknown; metaPageId?: unknown;
  },
): string | null {
  if (typeof d.youtubeChannelId === "string" && d.youtubeChannelId) return d.youtubeChannelId;
  if (typeof d.naverAccountId === "string" && d.naverAccountId) return d.naverAccountId;
  if (typeof d.tiktokOpenId === "string" && d.tiktokOpenId) return d.tiktokOpenId;
  if (typeof d.igUserId === "string" && d.igUserId) return d.igUserId;
  if (typeof d.metaPageId === "string" && d.metaPageId) return d.metaPageId;
  return null;
}

/**
 * 클립의 distributions 배열에서 한 채널·**한 계정** 항목을 갱신한다(새 배열 반환).
 * index.ts 와 worker.ts 에 같은 함수가 두 벌 있던 것을 하나로 합쳤다.
 *
 * 채널당 1행이면 규칙에 같은 플랫폼 계정 A·B 를 넣었을 때 기록이 서로 덮여,
 * 순방의 "이미 나갔나" 체크가 매번 거짓이 되어 **같은 클립이 계속 재업로드**된다.
 * 그래서 매칭 키는 채널 + 계정 정체성이다 — value 에 실린 정체성이 같은 항목만 갱신하고,
 * 다르면 별도 항목으로 쌓는다. 정체성 없는 쓰기(기록 전용 채널·레거시)는 예전처럼
 * 채널 단독으로 매칭한다.
 */
export function upsertDistribution<T extends { channel: string }>(
  distributions: T[] | undefined,
  channel: string,
  value: Record<string, unknown>,
): T[] {
  const next = (distributions ?? []).map((d) => ({ ...d }));
  const acct = distributionAccountId(value);
  const existing = next.find((d) =>
    d.channel === channel
    && (acct === null || distributionAccountId(d as Record<string, unknown>) === acct));
  if (existing) Object.assign(existing, value);
  else next.push({ channel, ...value } as T);
  return next;
}

/**
 * 이 채널·이 계정으로 이미 나갔는가(실패 제외) — 자동 순방의 중복 게시 방지 판정.
 * 계정 식별자가 없는 행(구 데이터)은 플랫폼 일치만으로 **보수적으로 참** —
 * 중복 게시가 놓친 게시보다 나쁘다.
 */
export function hasAccountDistribution(
  distributions:
    | Array<{
        channel: string; status?: string;
        youtubeChannelId?: unknown; naverAccountId?: unknown; tiktokOpenId?: unknown;
      }>
    | undefined,
  channel: string,
  accountId: string,
): boolean {
  return (distributions ?? []).some((d) => {
    if (d.channel !== channel || d.status === "failed") return false;
    const acct = distributionAccountId(d);
    return acct === null || acct === accountId;
  });
}

/**
 * 이 채널·이 계정으로 **실패한** 배포 행이 있는가.
 *
 * 자동 순방은 이걸 보면 멈춰야 한다. 실패 행은 `hasAccountDistribution` 이 "안 나간 것" 으로
 * 보기 때문에, 막지 않으면 순방이 10분마다 같은 클립·같은 계정으로 재업로드를 건다 —
 * 백오프도 상한도 없이. **업로드가 실제로 시작된 뒤 응답만 유실된 실패**면 채널에 같은
 * 영상이 중복 게시되고, 네이버는 재로그인이 반복돼 계정 잠금·캡차 위험이 커진다.
 * 워커(worker.ts)와 재시도 라우트는 "재시도는 사람이 누른다"(F4-4)를 지키는데 순방만
 * 이 금지를 우회하고 있었다.
 */
export function hasFailedAccountDistribution(
  distributions:
    | Array<{
        channel: string; status?: string;
        youtubeChannelId?: unknown; naverAccountId?: unknown; tiktokOpenId?: unknown;
      }>
    | undefined,
  channel: string,
  accountId: string,
): boolean {
  return (distributions ?? []).some((d) => {
    if (d.channel !== channel || d.status !== "failed") return false;
    const acct = distributionAccountId(d);
    return acct === null || acct === accountId;
  });
}

/** 배포에서 제외된 건과 그 사유. **사유 없는 제외는 타입이 허용하지 않는다.** */
export interface PublishSkip {
  clipId: string;
  /** 기계가 읽는 사유 코드. UI 문구와 분리한다. */
  code: "not_rendered" | "gate_blocked" | "channel_unsupported" | "not_found";
  /** 사람이 읽는 사유. 토스트에 그대로 쓸 수 있어야 한다. */
  reason: string;
}

export interface PublishScreenResult {
  /** 실제로 큐에 넣을 클립. */
  queue: string[];
  /** 제외된 건 — 호출부는 이 건수를 **반드시** 사용자에게 알린다 (FLOWS.md:69 ⚑). */
  skipped: PublishSkip[];
}

/**
 * 선택된 클립들을 배포 가능/불가로 가른다.
 *
 * FLOWS.md:69 — "게이트 미통과 건이 선택에 섞여 있으면 통과 건만 진행하고, 제외된
 * 건수를 ⚑ 토스트로 알린다. ⊘ 조용히 제외 금지, ⊘ 전체 실패 처리 금지."
 *
 * 그래서 이 함수는 **던지지 않는다.** 한 건이 막혔다고 전체를 실패시키면 명세 위반이고,
 * 제외를 반환값에서 빼면 조용한 제외가 된다. 둘 다 타입으로 막았다.
 *
 * @param gateOf 게이트 판정. **S1b 에서 gate.ts 가 들어오기 전까지는 전부 통과로 넘어온다.**
 *   optional 로 두지 않은 이유: 기본값을 두면 게이트를 빠뜨린 호출이 조용히 통과한다.
 */
export function screenForPublish(
  clips: Array<{ id: string; rendered?: boolean; mediaId?: unknown; status?: string }>,
  ctx: {
    channel: PublishChannel;
    gateOf: (clipId: string) => { allowed: boolean; reason: string };
  },
): PublishScreenResult {
  const queue: string[] = [];
  const skipped: PublishSkip[] = [];

  for (const clip of clips) {
    if (!isClipRendered(clip)) {
      skipped.push({
        clipId: clip.id, code: "not_rendered",
        reason: "렌더가 끝나지 않았습니다 — 내보내기 후 다시 시도해 주세요.",
      });
      continue;
    }
    const gate = ctx.gateOf(clip.id);
    if (!gate.allowed) {
      skipped.push({ clipId: clip.id, code: "gate_blocked", reason: gate.reason });
      continue;
    }
    queue.push(clip.id);
  }
  return { queue, skipped };
}
