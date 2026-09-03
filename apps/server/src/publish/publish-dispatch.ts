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
import {
  channelPublishMode,
  distributionStatusFor,
  isNaverChannel,
  isPublishChannel,
  NAVER_CHANNELS,
  screenForPublish,
  upsertDistribution,
  type PublishSkip,
} from "./publish-guard.ts";
import {
  addCreditEntry,
  appendGateAudit,
  creditBalance,
  getEntity,
  putEntity,
} from "../db-pg.ts";
import { enqueue } from "../pipeline/queue.ts";
import { topupAndRecheck } from "../billing/auto-topup.ts";
import { publishCredits } from "../billing/credits.ts";
import { tiktokUploadEnabled, instagramUploadEnabled, facebookUploadEnabled } from "./upload-gate.ts";

export interface PublishInput {
  clipIds: string[];
  channel: string;
  scheduled?: boolean;
  reserveDate?: string;
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
  /**
   * TikTok 전용 — 어느 계정 받은함에 초안을 넣을지. 네이버와 같은 이유로 **추론하지 않는다**.
   * 게이트 ON 인데 이 값이 없으면 record 로 남긴다 — 어디로 갈지 모르는 업로드는 안 하는 게 맞다.
   */
  tiktokOpenId?: string;
  /**
   * Instagram 전용 — 어느 IG 비즈니스 계정(igUserId)으로 올릴지. 다른 채널과 같은 이유로
   * **추론하지 않는다**. 게이트 ON 인데 없으면 record.
   */
  igUserId?: string;
  /** Facebook 전용 — 어느 Meta 페이지(pageId)로 올릴지. 추론하지 않는다. */
  metaPageId?: string;
  /** 누가 눌렀나. 감사 로그에 남는다. */
  actor: string;
  /**
   * 어디서 왔나 — manual(사람이 버튼) | retry(사람이 재시도) | factory(공장 API) |
   * automation(자동 순방). 배포 기록 행에도 남아 화면이 자동/수동을 구분한다.
   */
  origin: "manual" | "retry" | "factory" | "automation";
}

export interface PublishOutcome {
  /** 실업로드 큐에 들어간 클립 (YouTube · 네이버 TV/클립 · TikTok 게이트 ON 드래프트). */
  queued: string[];
  /** 파일이 올라가지 않고 상태만 기록된 클립 (Meta · TikTok 게이트 OFF). */
  recorded: string[];
  /** 게이트·렌더 때문에 빠진 클립. **버리지 않고 사유와 함께 돌려준다.** */
  skipped: PublishSkip[];
  /** 사람에게 보여줄 한 줄. 빈 문자열이면 알릴 게 없다. */
  notice: string;
}


/**
 * 배포 실행. 게이트를 통과한 것만 나간다.
 *
 * ⊘ 조용히 제외 금지 · ⊘ 전체 실패 처리 금지 (FLOWS.md:70) —
 * 막힌 게 섞여 있어도 통과 건은 진행하고, 빠진 건수와 사유를 반드시 돌려준다.
 */
export async function dispatchPublish(input: PublishInput): Promise<PublishOutcome> {
  // 채널명부터 거른다 — channelPublishMode 는 모르는 값을 record 로 처리하므로, 여기서
  // 막지 않으면 오타·폐기 채널("meta" 등)이 조용히 '기록됨'으로 수락된다.
  if (!isPublishChannel(input.channel)) {
    const skipped: PublishSkip[] = input.clipIds.map((clipId) => ({
      clipId, code: "channel_unsupported",
      reason: `지원하지 않는 채널입니다: ${input.channel}`,
    }));
    return { queued: [], recorded: [], skipped, notice: noticeFor({ queued: [], recorded: [], skipped }, input.channel) };
  }
  // TikTok 실업로드(받은함 드래프트)는 게이트 + 계정 지정 둘 다 있어야 한다.
  // 게이트 OFF 거나 계정 미지정(자동 순방 등 구 호출부)이면 예전 그대로 record.
  const mode = channelPublishMode(input.channel, {
    tiktokUpload: tiktokUploadEnabled() && Boolean(input.tiktokOpenId),
    instagramUpload: instagramUploadEnabled() && Boolean(input.igUserId),
    facebookUpload: facebookUploadEnabled() && Boolean(input.metaPageId),
  });

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

  // 2) 렌더·채널 조건만 본다.
  //
  // ⚠️ **권리 게이트는 제거했다**(사용자 결정 2026-08-31: "실전에서 필요가 없음").
  // 근거 데이터: `rights_issue` **0행** — 운영 시작 이래 아무도 권리 이슈를 등록한 적이 없고,
  // `gate_audit` 도 `publish.allowed` 114건 대 `publish.blocked` **1건**(수동 판정 테스트에
  // 딸린 것)이었다. 즉 실제 콘텐츠를 막은 적이 한 번도 없으면서, 발행마다 조회 2건과
  // "미판정=검수대기" 규칙으로 사람 손을 요구했다.
  //
  // 배포 **기록**은 그대로 남는다(`appendGateAudit` 은 게이트가 아니라 db-pg 의 감사 로그다) —
  // "언제 무슨 영상이 어디로 나갔는지" 는 고객사 요구가 있을 수 있어 유지한다.
  const screen = screenForPublish(
    loaded.map(({ id, clip }) => ({ id, rendered: clip.rendered, mediaId: clip.mediaId, status: clip.status })),
    { channel: input.channel },
  );
  skipped.push(...screen.skipped);

  // 3) 통과 건만 진행.
  const queued: string[] = [];
  const recorded: string[] = [];
  const status = distributionStatusFor(mode, Boolean(input.scheduled));
  // 예약 시각은 여기서 한 번만 정규화한다(KST 해석) — 기록·큐 페이로드·지연 계산이
  // 전부 이 값을 쓴다. 채널마다 따로 파싱하면 한 채널만 +9시간 밀리는 반쪽 수정이 된다.
  const reserveDate = normalizeReserveDate(input.reserveDate);

  // 업로드 과금 어휘 — 영상×채널 3크레딧(사용자 2026-08-26 · "1은 너무 적다" 1→3).
  // record 모드는 실물이 안 올라가므로 무과금. 실패하면 워커(markDistributionFailed)가
  // 행에 남긴 chargeKey·차감량으로 환급한다 — 단가가 또 바뀌어도 옛 차감은 옛 값대로 돌아간다.
  const publishCost = publishCredits();
  const acctField = input.channel === "youtube" ? "youtubeChannelId"
    : input.channel === "tiktok" ? "tiktokOpenId"
    : input.channel === "instagram" ? "igUserId"
    : input.channel === "facebook" ? "metaPageId" : "naverAccountId";
  const acctVal = String(
    input.youtubeChannelId ?? input.tiktokOpenId ?? input.igUserId
    ?? input.metaPageId ?? input.naverAccountId ?? "",
  ).trim();

  for (const clipId of screen.queue) {
    const clip = loaded.find((l) => l.id === clipId)!.clip;

    // ── 배포 크레딧 차감 ──────────────────────────────────────────────────────
    // 같은 행이 이미 차감된 채 진행 중이면(더블클릭 재디스패치 — 큐는 dedupe 로 하나만 돈다)
    // 다시 물리지 않는다. 실패·신규 행만 차감 — 재시도는 환급 후라 다시 차감되는 게 맞다.
    let chargeKey: string | null = null;
    if (mode === "upload" && publishCost > 0) {
      const rows: any[] = Array.isArray(clip.distributions) ? clip.distributions : [];
      const prev = rows.find((d) => d?.channel === input.channel
        && (!acctVal || !d?.[acctField] || String(d[acctField]) === acctVal));
      const alreadyCharged = prev?.creditCharged === true
        && (prev?.status === "pending" || prev?.status === "scheduled");
      if (!alreadyCharged) {
        if ((await creditBalance()) < publishCost) {
          // 분석 게이트와 같은 처방 — 완전소진이면 자동충전을 먼저 시도하고 다시 본다.
          await topupAndRecheck(publishCost).catch(() => null);
        }
        if ((await creditBalance()) < publishCost) {
          skipped.push({
            clipId, code: "credits",
            reason: `크레딧이 부족해 배포하지 못했습니다 — 배포는 영상·채널당 ${publishCost}크레딧입니다. 충전 후 다시 시도해 주세요.`,
          });
          continue; // 행을 건드리지 않는다 — 거부된 요청은 화면을 있던 그대로 둔다.
        }
        chargeKey = `publish:${clipId}:${input.channel}:${acctVal || "-"}:${Date.now()}`;
        await addCreditEntry({
          delta: -publishCost, reason: "publish",
          note: `${input.channel} 배포 · ${clipId}`,
          actor: input.actor || input.origin, dedupeKey: chargeKey,
        });
      }
    }

    const value: Record<string, unknown> = {
      // 과금 흔적 — 실패 환급(워커)이 이 값들을 본다. 재디스패치(chargeKey null)면 기존 값 유지.
      // 차감량을 행에 박는다 — 단가 변경 후에도 옛 차감은 그 값 그대로 환급된다.
      ...(chargeKey ? { creditCharged: true, creditChargeKey: chargeKey, creditChargeCredits: publishCost } : {}),
      status,
      error: undefined,
      // 자동/수동 구분을 기록 자체에 남긴다 — 감사 로그(basis)에만 있으면 화면이 못 읽는다.
      // 워커의 후속 갱신(Object.assign 병합)은 origin 키를 안 보내므로 이 값이 보존된다.
      origin: input.origin,
      ...(reserveDate ? { reserveDate } : {}),
      // 계정 정체성은 **record 모드에도** 남긴다. 예전엔 upload 조건이 걸려 있어 게이트
      // OFF 로 남는 record 행이 정체성 없는(null) 행이 됐고, hasAccountDistribution 의
      // 보수 규칙(null = 모든 계정 일치)이 같은 플랫폼의 **2번째 계정을 영구 스킵**시켰다.
      ...(input.channel === "youtube" && input.youtubeChannelId
        ? { youtubeChannelId: input.youtubeChannelId } : {}),
      // 의도한 공개범위를 **행에 남긴다** — 실패 후 사람 재시도(/api/distributions/retry)가
      // 이 값을 되살려 보낸다. 없으면 재시도가 워커 폴백으로 떨어져 unlisted/private 의도
      // 콘텐츠가 전체공개로 승격되는 사고가 난다(2026-08-25 전면 체크 major).
      ...(input.channel === "youtube" && input.privacy ? { privacy: input.privacy } : {}),
      // 어느 네이버 계정으로 나갔는지를 배포 기록에 남긴다. B2B 다계정에서 이게 없으면
      // 나중에 "이 클립 어느 채널에 올라갔지?" 를 로그로만 추적해야 한다.
      ...(isNaverChannel(input.channel) && input.naverAccountId
        ? { naverAccountId: input.naverAccountId } : {}),
      // TikTok 도 계정 정체성을 기록에 남긴다 — 없으면 다계정에서 기록이 서로 덮인다.
      ...(input.channel === "tiktok" && input.tiktokOpenId
        ? { tiktokOpenId: input.tiktokOpenId } : {}),
      ...(input.channel === "instagram" && input.igUserId
        ? { igUserId: input.igUserId } : {}),
      ...(input.channel === "facebook" && input.metaPageId
        ? { metaPageId: input.metaPageId } : {}),
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
        publishAt: naverPublishAt(input.scheduled, reserveDate),
      }, {
        // 같은 클립을 같은 계정·같은 타깃에 두 번 넣지 않는다. 네이버는 중복 게시를
        // 되돌리기가 번거롭다.
        dedupeKey: `naver.publish:${clipId}:${input.channel}:${input.naverAccountId ?? "-"}`,
      });
      queued.push(clipId);
    } else if (mode === "upload" && input.channel === "tiktok") {
      // TikTok 드래프트도 **같은 잡 타입**(distribution.publish)으로 간다 — channel 로 워커가
      // 분기한다. 잡 타입을 늘리면 레인 배정(worker-lanes)이 또 필요하고, 성격(짧은 API 업로드)이
      // YouTube 배포와 같아 youtube 레인이 맞다.
      await enqueue("distribution.publish", {
        clipId,
        channel: "tiktok",
        tiktokOpenId: input.tiktokOpenId,
      }, {
        // dedupe 에 채널을 박는다 — youtube 키(clipId:channelId)와 충돌하면 한쪽이 조용히 빠진다.
        dedupeKey: `distribution.publish:${clipId}:tiktok:${input.tiktokOpenId}`,
        // TikTok Content Posting API 는 예약 파라미터가 없다 → 예약이면 잡을 그 시각까지 지연 발사.
        ...scheduleDelay(input.scheduled, reserveDate),
      });
      queued.push(clipId);
    } else if (mode === "upload" && input.channel === "instagram") {
      // IG 도 예약 API 가 없다(우리쪽 발사) → 잡을 예약 시각까지 지연시키고 워커가 그때
      // 컨테이너→media_publish 로 발사한다. 잡 타입은 distribution.publish 공유(youtube 레인).
      await enqueue("distribution.publish", {
        clipId,
        channel: "instagram",
        igUserId: input.igUserId,
      }, {
        dedupeKey: `distribution.publish:${clipId}:instagram:${input.igUserId ?? "-"}`,
        ...scheduleDelay(input.scheduled, reserveDate),
      });
      queued.push(clipId);
    } else if (mode === "upload" && input.channel === "facebook") {
      // FB 는 **네이티브 예약**(scheduled_publish_time) → 잡은 즉시 돌고, 워커가 그 시각을
      // finish 단계에 실어 SCHEDULED 로 등록한다. reserveDate 를 페이로드로 넘긴다.
      await enqueue("distribution.publish", {
        clipId,
        channel: "facebook",
        metaPageId: input.metaPageId,
        // 정규화된 문자열을 넘긴다 — 워커의 Date.parse 가 KST 오프셋을 그대로 읽는다.
        scheduleDate: input.scheduled ? reserveDate : undefined,
      }, {
        dedupeKey: `distribution.publish:${clipId}:facebook:${input.metaPageId ?? "-"}`,
      });
      queued.push(clipId);
    } else if (mode === "upload") {
      // ⚠️ 배포 큐에 넣는 **유일한 지점**. 여기 밖에서 enqueue 하면 게이트를 우회하게 된다.
      // 예약의 수단이 공개 범위에 따라 갈린다(2026-08-25 전면 체크):
      //  - public: 유튜브 네이티브 publishAt — private 로 잡아뒀다가 그 시각에 **공개**된다.
      //  - unlisted/private: publishAt 을 걸면 운영자가 정한 공개 범위가 조용히 public 으로
      //    바뀐다(youtubeReleasePlan 주석의 그 메커니즘). 대신 **잡 자체를 슬롯 시각까지
      //    지연**(TikTok/IG 패턴)해 업로드 시각만 맞추고 공개 범위는 그대로 둔다.
      const nativeSchedule = input.scheduled && input.privacy === "public";
      await enqueue("distribution.publish", {
        clipId,
        channelId: input.youtubeChannelId,
        privacy: input.privacy,
        // 예약은 미래 시각으로 파싱될 때만 효력이 있다. 정규화된 문자열을 넘긴다 —
        // 워커의 futurePublishAt(Date.parse)이 KST 오프셋을 그대로 읽는다.
        publishAt: nativeSchedule ? reserveDate : undefined,
      }, {
        dedupeKey: `distribution.publish:${clipId}:${input.youtubeChannelId ?? "-"}`,
        // 비-public 은 **리드를 준다** — 올려도 공개되지 않으므로 미리 올리는 게 안전하고,
        // 슬롯 시각에는 이미 올라가 있어야 편집자가 그때 확인할 수 있다.
        ...(input.scheduled && !nativeSchedule
          ? scheduleDelay(input.scheduled, reserveDate, UPLOAD_LEAD_MIN) : {}),
      });
      queued.push(clipId);
    } else {
      recorded.push(clipId);
    }
  }

  return { queued, recorded, skipped, notice: noticeFor({ queued, recorded, skipped }, input.channel) };
}

/**
 * 예약 문자열 정규화 — **TZ 정보가 없으면 KST(+09:00) 로 해석한다.**
 *
 * 화면의 datetime-local 은 'YYYY-MM-DDTHH:mm' 을 만드는데, ES 규격상 Date.parse 는
 * 오프셋 없는 date-time 문자열을 **UTC** 로 읽는다. 서버(Cloud Run)가 UTC 라서 KST
 * 사용자의 예약이 전 채널에서 +9시간 밀렸다 — "저녁 7시 예약"이 다음날 새벽 4시에 나간다.
 * 사용자는 KST 로 입력한다(제품이 한국 방송사 대상)는 사실을 여기서 못박는다.
 *
 * 이미 오프셋('Z'·±hh:mm)이 있는 문자열은 손대지 않는다 — 명시된 TZ 는 존중한다.
 * 날짜만('YYYY-MM-DD') 온 경우도 KST 자정으로 해석한다(그냥 +09:00 을 붙이면 파싱 불가).
 */
export function normalizeReserveDate(reserveDate: string | undefined): string | undefined {
  const s = (reserveDate ?? "").trim();
  if (!s) return undefined;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00+09:00` : `${s}+09:00`;
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
 * 네이티브 예약이 없는 채널(Instagram·TikTok)의 예약 = **잡을 그 시각까지 지연**시켜
 * 워커가 발사한다(우리쪽 발사). 큐의 delayMs(= runAfter) 를 쓴다. 과거·해석불가는 지연 없음
 * (= 즉시 발사) — 예약은 못 걸리는 것보다 틀리는 게 나쁘다(YouTube/네이버와 같은 방향).
 */
/**
 * **업로드를 몇 분 일찍 시작하는가** (유튜브 비-public 예약 전용).
 *
 * 사용자 2026-09-03: *"private 라도 5분 일찍 올려서 6시에는 편집자가 '올라갔구나' 확인하길
 * 바라는 마음."* 맞다. 슬롯 시각은 **"업로드를 시작하는 시각"이 아니라 "이미 올라가 있는
 * 시각"** 이어야 한다. 18:00 에 업로드를 시작하면 편집자가 18:00 에 보는 건 빈 채널이다.
 *
 * 5분인 이유: 쇼츠 한 편(수십 MB)은 보통 1분 안에 끝난다. 넉넉히 잡되, 너무 길면 "예약
 * 시각보다 한참 먼저 올라가 있다" 가 되어 그것대로 헷갈린다.
 */
export const UPLOAD_LEAD_MIN = 5;

/**
 * 예약 시각까지 잡을 지연시킨다.
 *
 * ⚠️ **`leadMin` 은 유튜브 비-public 경로에서만 쓴다.** TikTok·Instagram 은 이 잡이 곧
 *    **게시**라(예약 API 가 없어 우리가 그 시각에 발사한다) 일찍 쏘면 **글이 일찍 올라간다.**
 *    유튜브 비-public 은 올려도 공개되지 않으니 미리 올리는 게 안전하고, 그게 목적이다.
 */
function scheduleDelay(
  scheduled: boolean | undefined, reserveDate: string | undefined, leadMin = 0,
): { delayMs?: number } {
  if (!scheduled || !reserveDate) return {};
  const t = Date.parse(reserveDate);
  if (!Number.isFinite(t)) return {};
  // 이미 리드 창 안이면 지연 없이 지금 쏜다(음수 지연은 없다).
  const ms = t - leadMin * 60_000 - Date.now();
  return ms > 0 ? { delayMs: ms } : {};
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
  channel_unsupported: "지원하지 않는 채널",
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
