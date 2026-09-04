/**
 * 완전자동화 수확 순회 — 등록된 수집원을 보고 **회차를 한 편 만든다.**
 *
 * ⚠️ **테넌트 안에서만 돈다.** `automation-cycle.ts` 와 같은 규칙이다 — 워커가 잡을 집을 때
 * `job.tenantId` 로 컨텍스트를 세우므로, 순회를 **테넌트별 잡**으로 쪼개는 것이 곧 격리다.
 * 이 파일 어디에도 `runAsSystem` 이 없다.
 *
 * ## 판정과 배선을 갈라 뒀다
 *
 *   `harvest.ts`        무엇을 집을지 · 상한 · 예상치 (순수 · 테스트가 여기를 본다)
 *   이 파일             조회 · 회차 생성 요청 · 상태 기록
 *
 * 상한을 이 파일에 적으면 DB 를 띄워야 검증되고, 그러면 아무도 검증하지 않는다.
 *
 * ## 회차를 직접 만들지 않는다 — 기존 라우트를 부른다
 *
 * `POST /api/media/from-youtube` 가 이미 회차·미디어를 만들고 다운로드를 큐잉하고 크레딧을
 * 본다. 그 로직을 여기로 복제하면 두 벌이 되고, 한쪽만 고쳐지는 날이 온다. 공장(factory)이
 * 렌더를 부를 때 쓰는 것과 **같은 내부 호출 경로**(`apiBase` + `internalHeaders`)를 쓴다.
 */
import {
  creditBalance, getEntity, getChannelVideoByVideoId, harvestCounts, harvestedVideoIds,
  listAutomationRules, listChannelVideosForHarvest, listHarvestSources, listYouTubeChannels,
  pendingClipCount, updateHarvestSource, updateYouTubeTokens, upsertChannelVideo,
  type HarvestSourceRow, type YouTubeChannel,
} from "../db-pg.ts";
import { perDayCount, rulePrograms, type AutomationRule } from "./automation.ts";
import { fetchChannelUploads, withAccessToken } from "../youtube.ts";
import { apiBase, internalHeaders } from "./factory.ts";
import { STUCK_AFTER_MS, pickNext, type ChannelVideo, type HarvestSource } from "./harvest.ts";

/** 하루 경계는 KST 다 — "오늘 몇 편" 이 사람이 보는 달력과 같아야 한다. */
function kstDayStartMs(now = Date.now()): number {
  const kst = new Date(now + 9 * 3_600_000);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3_600_000;
}

export interface HarvestOutcome {
  sourceId: string;
  sourceChannelId: string;
  /** 만든 회차의 videoId. 안 만들었으면 null. */
  picked: string | null;
  /** 안 만들었으면 왜. */
  note: string;
}

export interface HarvestReport {
  sources: number;
  made: number;
  outcomes: HarvestOutcome[];
}

/**
 * 이 프로그램의 **하루 배포 물량** — 걸린 자동배포 계획들의 하루 발행 수 합.
 *
 * 재고 게이트의 분모다. 계획이 없으면 0 이고, 그때는 재고 판정을 하지 않는다
 * (`harvest.ts` enoughStock 주석 — 계획을 나중에 만드는 순서도 정상이다).
 */
function dailyDemandFor(rules: AutomationRule[], programId: string): number {
  return rules
    .filter((r) => r.enabled !== false && rulePrograms(r).includes(programId))
    .reduce((sum, r) => sum + perDayCount(r), 0);
}

/** DB 행 → 판정부가 아는 모양. 필드 이름을 맞추는 것 말고는 하는 일이 없다. */
function toSource(r: HarvestSourceRow): HarvestSource {
  return {
    id: r.id, sourceChannelId: r.sourceChannelId, programId: r.programId,
    status: r.status, dailyCap: r.dailyCap, minDurationSec: r.minDurationSec,
    backfill: r.backfill, createdAt: r.createdAt,
  };
}

/**
 * 수집원의 업로드 목록을 새로 고친다.
 *
 * **연결된 채널 아무거나의 토큰**을 빌려 쓴다. 업로드 목록은 공개 데이터라 토큰 주인과
 * 대상이 같을 필요가 없고, 수집원은 애초에 우리가 연결하지 않은 채널일 수 있다.
 * 워크스페이스에 연결된 채널이 하나도 없으면 읽을 방법이 없다 — 그 사실을 그대로 알린다.
 */
async function refreshUploads(sourceChannelId: string): Promise<{ ok: true } | { ok: false; note: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return { ok: false, note: "유튜브 연동이 설정되지 않았습니다." };

  const lender: YouTubeChannel | undefined = (await listYouTubeChannels())
    .find((c) => c.status !== "disconnected" && c.refreshToken);
  if (!lender) {
    return { ok: false, note: "연결된 유튜브 채널이 없어 목록을 읽을 수 없습니다. 배포 채널을 먼저 연결하세요." };
  }

  try {
    const videos = await withAccessToken(
      clientId, clientSecret, lender,
      ({ accessToken, expiresAt }) => updateYouTubeTokens(lender.channelId, accessToken, expiresAt),
      (accessToken) => fetchChannelUploads(accessToken, sourceChannelId),
    );
    for (const v of videos) {
      const existing = await getChannelVideoByVideoId(v.videoId);
      await upsertChannelVideo({
        id: existing?.id ?? `cv_${v.videoId}`,
        channelId: sourceChannelId,
        videoId: v.videoId,
        title: v.title,
        description: v.description,
        publishedAt: v.publishedAt,
        durationSec: v.durationSec,
        thumbnail: v.thumbnail,
        viewCount: v.viewCount,
        likeCount: v.likeCount,
        commentCount: v.commentCount,
        lastSynced: Date.now(),
      });
    }
    return { ok: true };
  } catch (e) {
    // 채널이 비공개거나 없어졌을 수 있다. 수확을 멈추되 수집원은 살려 둔다 —
    // 다음 순회에 다시 시도하고, 계속 실패하면 화면의 사유로 사람이 안다.
    return { ok: false, note: `업로드 목록을 읽지 못했습니다: ${String(e).slice(0, 120)}` };
  }
}

/**
 * 회차 하나를 만든다 — 기존 `/api/media/from-youtube` 를 그대로 부른다.
 *
 * 실패를 삼키지 않는다. 402(크레딧)·400(프로그램 없음)은 사람이 고쳐야 하는 것이고,
 * 그 사유가 화면까지 가야 "왜 안 도는지" 를 알 수 있다.
 */
async function requestEpisode(source: HarvestSourceRow, video: ChannelVideo): Promise<string | null> {
  const res = await fetch(`${apiBase()}/api/media/from-youtube`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await internalHeaders()) },
    body: JSON.stringify({
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      programId: source.programId,
      title: video.title,
    }),
  });
  if (res.ok) return null;

  const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
  return body?.message ?? body?.error ?? `회차 생성 실패 (${res.status})`;
}

/**
 * 한 순회. **수집원마다 최대 한 편.**
 *
 * 여러 편을 한 번에 만들지 않는 이유는 `harvest.ts` 머리말에 적어 뒀다 — 크레딧이 한꺼번에
 * 나가고, 워커가 한 채널에 막힌다. 전체 소급은 "하루 상한 × 매일" 로 천천히 내려간다.
 */
export async function runHarvestCycle(): Promise<HarvestReport> {
  const [sources, rules] = await Promise.all([listHarvestSources(), listAutomationRules()]);
  const outcomes: HarvestOutcome[] = [];
  let made = 0;

  for (const row of sources) {
    const base = { sourceId: row.id, sourceChannelId: row.sourceChannelId };

    // 상태부터 본다 — 목록을 읽는 것도 API 쿼터라, 안 돌 수집원에 쓰지 않는다.
    if (row.status !== "active") {
      outcomes.push({ ...base, picked: null, note: row.status === "paused" ? "일시정지" : "승인 대기" });
      continue;
    }

    // 목록 갱신은 **최선을 다하되 막지는 않는다.** 실패해도 이미 동기화해 둔 업로드로
    // 수확은 이어간다 — 갱신 실패(토큰 만료·채널 비공개)로 어제까지 알던 영상까지 멈추면,
    // 고칠 때까지 자동화가 통째로 선다. 다만 후보가 하나도 없을 때는 "새 영상 없음" 이
    // 아니라 **갱신에 실패했다는 사실**을 알려야 한다(아래 refreshNote).
    const refreshed = await refreshUploads(row.sourceChannelId);
    const refreshNote = refreshed.ok ? null : refreshed.note;

    const [videos, alreadyMade, counts, balance, stock] = await Promise.all([
      listChannelVideosForHarvest(row.sourceChannelId),
      harvestedVideoIds(row.sourceChannelId),
      harvestCounts(row.sourceChannelId, kstDayStartMs(), Date.now() - STUCK_AFTER_MS),
      creditBalance().catch(() => null),
      pendingClipCount(row.programId),
    ]);

    const verdict = pickNext({
      source: toSource(row),
      videos,
      alreadyMade,
      madeToday: counts.madeToday,
      inFlight: counts.inFlight,
      stuck: counts.stuck,
      creditBalance: balance,
      stock,
      dailyDemand: dailyDemandFor(rules as AutomationRule[], row.programId),
    });

    await updateHarvestSource(row.id, { lastRunAt: Date.now() });

    // 멈춘 편 경고는 **결론과 무관하게** 앞에 붙인다. 이건 "왜 안 집었나" 가 아니라
    // "앞서 만든 게 죽어 있다" 는 별개의 사실이고, 사람이 손대야 하는 쪽이다.
    const withWarning = (note: string) => (verdict.warning ? `${verdict.warning} · ${note}` : note);

    if (!verdict.pick) {
      // 후보가 없는데 갱신도 실패했다면, 진짜 사유는 갱신 실패다. "새 영상 없음" 으로
      // 덮으면 사람이 채널을 잘못 등록했다고 오해한다.
      const note = verdict.code === "no_candidate" && refreshNote ? refreshNote : verdict.reason;
      outcomes.push({ ...base, picked: null, note: withWarning(note) });
      continue;
    }

    // 프로그램이 사라졌으면 만들지 않는다 — 라우트가 400 을 주기 전에 여기서 말이 되는
    // 사유를 남긴다("program not found" 보다 사람이 읽을 수 있다).
    if (!(await getEntity("program", row.programId))) {
      outcomes.push({ ...base, picked: null, note: "연결된 프로그램이 없습니다. 수집원을 다시 등록해 주세요." });
      continue;
    }

    const failure = await requestEpisode(row, verdict.pick);
    if (failure) {
      outcomes.push({ ...base, picked: null, note: failure });
      continue;
    }

    made += 1;
    outcomes.push({
      ...base, picked: verdict.pick.videoId,
      note: withWarning(`${verdict.pick.title} — ${verdict.needCredits}크레딧`),
    });
  }

  return { sources: sources.length, made, outcomes };
}
