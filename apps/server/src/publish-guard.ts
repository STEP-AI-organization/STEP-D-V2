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
export type PublishChannel = "youtube" | "instagram" | "facebook" | "tiktok" | "smr" | (string & {});

/**
 * 채널이 실제로 파일을 올리는가, 기록만 남기는가 (FLOWS.md:86-87).
 *
 * YouTube 만 실업로드다. 나머지는 "실제 게시는 담당자가 해당 앱에서 직접" 하고
 * 우리는 기록만 남긴다. **이 구분이 사라지면 F4 Invariant(FLOWS.md:92)가 깨진다** —
 * 올라가지도 않은 것을 '게시됨'으로 보여주게 된다.
 */
export function channelPublishMode(channel: PublishChannel): "upload" | "record" {
  return channel === "youtube" ? "upload" : "record";
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
 * 클립의 distributions 배열에서 한 채널 항목을 갱신한다(새 배열 반환).
 * index.ts 와 worker.ts 에 같은 함수가 두 벌 있던 것을 하나로 합쳤다.
 */
export function upsertDistribution<T extends { channel: string }>(
  distributions: T[] | undefined,
  channel: string,
  value: Record<string, unknown>,
): T[] {
  const next = (distributions ?? []).map((d) => ({ ...d }));
  const existing = next.find((d) => d.channel === channel);
  if (existing) Object.assign(existing, value);
  else next.push({ channel, ...value } as T);
  return next;
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
