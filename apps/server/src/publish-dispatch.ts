/**
 * 배포 관문 — **게시로 가는 유일한 문** (FLOWS F3 강제 · F4).
 *
 * "게이트를 통과하지 않은 미디어는 **어떤 경로로도** 게시되지 않는다. 관리자 권한도
 * 우회 불가"(FLOWS.md:73). 그 "어떤 경로로도"는 판정 함수 하나로는 지킬 수 없다 —
 * 새 경로가 하나 생기면 그만이기 때문이다. 그래서 **큐에 넣는 지점을 이 파일 하나로 모으고**,
 * 다른 파일에 `enqueue("distribution.publish"` 가 생기면 테스트가 깨지게 해 뒀다.
 *
 * 판정 자체는 여기 없다. 순수 규칙은 publish-guard.ts(렌더·채널 모드)와 gate.ts(권리·심의)에
 * 있고, 이 파일은 그 둘을 DB·큐에 잇는 배선이다.
 *
 * 호출부 4곳: `/api/distributions/publish` · `/api/distributions/retry` · factory · (워커는
 * 큐를 소비하는 쪽이라 여기 대신 자기 앞에서 게이트를 한 번 더 본다 — 큐에 앉아 있는 동안
 * 이슈가 새로 등록될 수 있다).
 */
import { evaluateGate } from "./gate.ts";
import {
  channelPublishMode,
  distributionStatusFor,
  isNaverChannel,
  NAVER_CHANNELS,
  screenForPublish,
  upsertDistribution,
  type PublishSkip,
} from "./publish-guard.ts";
import {
  appendGateAudit,
  getEntity,
  isJudged,
  listRightsIssues,
  putEntity,
} from "./db-pg.ts";
import { enqueue } from "./queue.ts";

export interface PublishInput {
  clipIds: string[];
  channel: string;
  scheduled?: boolean;
  reserveDate?: string;
  platforms?: string[];
  privacy?: "public" | "unlisted" | "private";
  /** YouTube 전용 — 어느 연결 채널로 올릴지. 추론하지 않는다. */
  youtubeChannelId?: string;
  /**
   * 네이버 전용 — 어느 네이버 계정으로 올릴지. B2B 다계정에서 **추론하면 안 된다**:
   * A사 클립이 B사 채널로 나가는 사고가 조용히 일어난다. 워커가 테넌트를 한 번 더 대조한다.
   */
  naverAccountId?: string;
  /** 네이버 전용 — 발행 시점에 사람이 넣는 설명(클립은 10자 이상 필수). 없으면 클립 synopsis. */
  description?: string;
  /** 네이버 전용 — 카테고리(1차·2차 둘 다 필수). 자동 판정하지 않는다. */
  naverCategory?: { primary: string; secondary: string };
  /** 누가 눌렀나. 감사 로그에 남는다. */
  actor: string;
  /** 어디서 왔나 — manual | retry | factory. 자동 실행 로그를 수동과 분리하기 위해. */
  origin: "manual" | "retry" | "factory";
}

export interface PublishOutcome {
  /** 실업로드 큐에 들어간 클립 (YouTube · 네이버 TV/클립). */
  queued: string[];
  /** 파일이 올라가지 않고 상태만 기록된 클립 (Meta·TikTok). */
  recorded: string[];
  /** 게이트·렌더 때문에 빠진 클립. **버리지 않고 사유와 함께 돌려준다.** */
  skipped: PublishSkip[];
  /** 사람에게 보여줄 한 줄. 빈 문자열이면 알릴 게 없다. */
  notice: string;
}

/** 한 클립의 게이트를 DB 에서 읽어 판정한다 (상태를 저장하지 않으므로 매번 계산). */
export async function clipGate(clipId: string) {
  const [issues, judged] = await Promise.all([
    listRightsIssues("clip", clipId),
    isJudged("clip", clipId),
  ]);
  return evaluateGate({
    judged,
    issues: issues.map((r) => ({
      id: r.id, kind: r.kind, resolution: r.resolution,
      bandStart: r.bandStart, bandEnd: r.bandEnd, note: r.note,
    })),
  });
}

/**
 * 배포 실행. 게이트를 통과한 것만 나간다.
 *
 * ⊘ 조용히 제외 금지 · ⊘ 전체 실패 처리 금지 (FLOWS.md:70) —
 * 막힌 게 섞여 있어도 통과 건은 진행하고, 빠진 건수와 사유를 반드시 돌려준다.
 */
export async function dispatchPublish(input: PublishInput): Promise<PublishOutcome> {
  const mode = channelPublishMode(input.channel);

  // 1) 클립을 읽는다. 없는 건 조용히 흘리지 않고 사유를 붙인다.
  const loaded: { id: string; clip: any }[] = [];
  const skipped: PublishSkip[] = [];
  for (const clipId of input.clipIds) {
    const clip = await getEntity<any>("clip", clipId);
    if (!clip) {
      skipped.push({ clipId, code: "not_found", reason: "클립을 찾을 수 없습니다." });
      continue;
    }
    loaded.push({ id: clipId, clip });
  }

  // 2) 게이트를 먼저 전부 계산한다(부작용 전에). 막힌 건 상태를 건드리지도 않는다 —
  //    거부된 요청은 화면을 있던 그대로 두고 나가야 한다.
  const gates = new Map<string, { allowed: boolean; reason: string; state: string }>();
  for (const { id } of loaded) {
    const g = await clipGate(id);
    gates.set(id, { allowed: g.allowed, reason: g.reason, state: g.state });
  }

  const screen = screenForPublish(
    loaded.map(({ id, clip }) => ({ id, rendered: clip.rendered, mediaId: clip.mediaId, status: clip.status })),
    {
      channel: input.channel,
      gateOf: (clipId) => gates.get(clipId) ?? { allowed: false, reason: "게이트를 확인할 수 없습니다." },
    },
  );
  skipped.push(...screen.skipped);

  // 3) 막힌 건은 감사 로그에 남긴다 — 무엇이 왜 안 나갔는지가 기록에 있어야 한다.
  for (const s of screen.skipped) {
    if (s.code !== "gate_blocked") continue;
    await appendGateAudit({
      subjectType: "clip", subjectId: s.clipId, action: "publish.blocked",
      fromState: gates.get(s.clipId)?.state ?? null, toState: "blocked",
      actor: input.actor || "unknown",
      basis: `${input.origin} 배포 시도 · ${input.channel} · ${s.reason}`,
    });
  }

  // 4) 통과 건만 진행.
  const queued: string[] = [];
  const recorded: string[] = [];
  const status = distributionStatusFor(mode, Boolean(input.scheduled));

  for (const clipId of screen.queue) {
    const clip = loaded.find((l) => l.id === clipId)!.clip;
    const value: Record<string, unknown> = {
      status,
      error: undefined,
      ...(input.reserveDate ? { reserveDate: input.reserveDate } : {}),
      ...(mode === "upload" && input.youtubeChannelId ? { youtubeChannelId: input.youtubeChannelId } : {}),
      ...(input.channel === "meta" && input.platforms ? { platforms: input.platforms } : {}),
      // 어느 네이버 계정으로 나갔는지를 배포 기록에 남긴다. B2B 다계정에서 이게 없으면
      // 나중에 "이 클립 어느 채널에 올라갔지?" 를 로그로만 추적해야 한다.
      ...(isNaverChannel(input.channel) && input.naverAccountId
        ? { naverAccountId: input.naverAccountId } : {}),
    };
    const distributions = upsertDistribution(clip.distributions, input.channel, value);

    // 클립을 published 로 승격하지 않는다 — 어느 모드에서도.
    // upload 모드는 워커가 실제로 올린 뒤에 승격하고, record 모드는 애초에 게시가 아니다.
    // 예전 코드는 Meta 스텁에서 clip.status = "published" 를 써서, 파일이 한 바이트도
    // 안 올라간 클립이 게시된 것처럼 보였다(F4 Invariant 위반).
    await putEntity("clip", clipId, { ...clip, distributions });

    await appendGateAudit({
      subjectType: "clip", subjectId: clipId, action: "publish.allowed",
      fromState: "pass", toState: status, actor: input.actor || "unknown",
      basis: `${input.origin} 배포 · ${input.channel}`,
    });

    if (mode === "upload" && isNaverChannel(input.channel)) {
      // 네이버는 별도 잡·별도 레인이다(사무실 PC · Playwright). 여기서 큐잉하는 이유는
      // 하나다 — **게이트를 지나는 문이 하나여야** 하기 때문이다. 잡 종류가 다르다고
      // 다른 파일에서 넣기 시작하면 그 문이 둘이 된다.
      await enqueue("naver.publish", {
        clipId,
        target: NAVER_CHANNELS[input.channel],
        naverAccountId: input.naverAccountId,
        description: input.description,
        category: input.naverCategory,
        // 워커는 epoch ms 를 본다. 문자열을 그대로 넘기면 Number() 가 NaN 이 되어
        // 예약이 조용히 사라지고 즉시 발행된다 — 예약은 못 걸리는 것보다 틀리는 게 나쁘다.
        publishAt: naverPublishAt(input.scheduled, input.reserveDate),
      }, {
        // 같은 클립을 같은 계정·같은 타깃에 두 번 넣지 않는다. 네이버는 중복 게시를
        // 되돌리기가 번거롭다.
        dedupeKey: `naver.publish:${clipId}:${input.channel}:${input.naverAccountId ?? "-"}`,
      });
      queued.push(clipId);
    } else if (mode === "upload") {
      // ⚠️ 배포 큐에 넣는 **유일한 지점**. 여기 밖에서 enqueue 하면 게이트를 우회하게 된다.
      await enqueue("distribution.publish", {
        clipId,
        channelId: input.youtubeChannelId,
        privacy: input.privacy,
        // 예약은 미래 시각으로 파싱될 때만 효력이 있다.
        publishAt: input.scheduled ? input.reserveDate : undefined,
      }, {
        dedupeKey: `distribution.publish:${clipId}:${input.youtubeChannelId ?? "-"}`,
      });
      queued.push(clipId);
    } else {
      recorded.push(clipId);
    }
  }

  return { queued, recorded, skipped, notice: noticeFor({ queued, recorded, skipped }, input.channel) };
}

/**
 * 예약 시각 → epoch ms. 과거·해석 불가는 undefined(= 즉시 발행)로 돌린다.
 * 워커도 한 번 더 거르지만, 여기서 NaN 을 만들어 보내지 않는 게 먼저다.
 */
function naverPublishAt(scheduled: boolean | undefined, reserveDate: string | undefined): number | undefined {
  if (!scheduled || !reserveDate) return undefined;
  const t = Date.parse(reserveDate);
  return Number.isFinite(t) && t > Date.now() ? t : undefined;
}

/**
 * 결과 한 줄. 제외된 건수가 **반드시** 들어간다 —
 * 조용히 빼면 사용자는 다 나간 줄 안다(FLOWS.md:70 ⊘).
 */
export function noticeFor(o: Omit<PublishOutcome, "notice">, channel: string): string {
  const parts: string[] = [];
  if (o.queued.length) parts.push(`${o.queued.length}건 업로드 시작`);
  if (o.recorded.length) parts.push(`${o.recorded.length}건 기록됨 (실제 게시는 ${channelName(channel)}에서 직접)`);

  if (o.skipped.length) {
    const byCode = new Map<string, number>();
    for (const s of o.skipped) byCode.set(s.code, (byCode.get(s.code) ?? 0) + 1);
    const detail = [...byCode.entries()]
      .map(([code, n]) => `${SKIP_LABEL[code] ?? code} ${n}건`)
      .join(" · ");
    parts.push(`제외 ${o.skipped.length}건 — ${detail}`);
  }
  return parts.join(" · ");
}

const SKIP_LABEL: Record<string, string> = {
  gate_blocked: "게이트 미통과",
  not_rendered: "렌더 전",
  not_found: "클립 없음",
};

function channelName(channel: string): string {
  return (
    {
      youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok",
      navertv: "네이버 TV", naverclip: "네이버 클립",
    }[
      channel
    ] ?? channel
  );
}
