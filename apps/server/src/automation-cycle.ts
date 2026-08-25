/**
 * 자동 배포 순방 (FLOWS F6). 규칙 하나하나를 5단계로 평가한다.
 *
 * ⚠️ **테넌트 안에서만 돈다.** 이 함수는 반드시 `runWithTenant(테넌트)` 컨텍스트 안에서
 * 불려야 한다 — 워커가 잡을 집을 때 `job.tenantId` 로 컨텍스트를 세우므로, 순방을
 * **테넌트별 잡**으로 쪼개는 것이 곧 격리다.
 *
 * 시스템 스코프('*')로 돌리면 RLS 가 전 테넌트 행을 보여주고, A 워크스페이스의 규칙이
 * B 의 채널로 나갈 수 있다. 그래서 이 파일 어디에도 runAsSystem 이 없다 —
 * 팬아웃(테넌트 목록 읽기)만 워커가 시스템으로 하고, 평가는 전부 테넌트 안이다.
 *
 * 5단계 (FLOWS.md F6):
 *   01 회차 수신   새 회차 감지 · 없으면 스킵
 *   02 분석        완료 전이면 다음 순방에 재확인
 *   03 미디어 생성 규칙 조건 통과분만 채택
 *   04 게이트 확인 막히면 보류 큐로 — 사람이 확정해야 다시 잡힌다
 *   05 게시        채널 규칙 적용해 배포 (실패는 자동 재시도 없음)
 */
import { commitAndInherit } from "./adopt.ts";
import {
  appendRuleRun,
  creditBalance,
  getEntity,
  hasReleasedHold,
  holdClip,
  isHeldAwaitingHuman,
  isRejectedHold,
  listAutomationRules,
  listEntities,
  listMedia,
  putEntity,
  getAutomationSetting,
  setAutomationSetting,
  getChannelRule,
  hasRunNote,
  publishedTodayKst,
  withTenantLock,
} from "./db-pg.ts";
import { currentTenantId } from "./tenant.ts";
import {
  AUTO_RENDER_STOPPED_NOTE, CREDIT_IDLE_REASON, CREDIT_STOP_NOTE, DEFAULT_RULE_THUMBNAIL_MODE,
  LAST_CYCLE_KEY, TOP3_CAP,
  autoRenderFailedNote, classifyRenderFailure,
  allowedToday, isPublishDay, ruleSlots, ruleWeekdays,
  decidePublish, episodeAnalysisState, inActiveWindow, isRuleThumbnailMode, matchesMediaKind,
  nextAutoRenderState,
  overlapsExistingClip, planCycle,
  ruleChannels, ruleIdleNote, rulePrograms, ruleWindow, scheduledSlotAt,
  slotsReadyForQueue, selectCandidates, shouldRequestAutoRender,
  type AutoRenderState, type AutomationRule, type RenderOutcome, type RuleIdleObservation,
} from "./automation.ts";
import {
  youtubeUploadEnabled, tiktokUploadEnabled, instagramUploadEnabled, facebookUploadEnabled,
} from "./upload-gate.ts";
import { naverUploadEnabled } from "./naver-gate.ts";
import { eligibility, nextPublishSlot, normalizePublishDelayMin, type ChannelRule } from "./channel-rules.ts";
import { newId } from "./pipeline.ts";
import { enqueue } from "./queue.ts";
import { distributionAccountId, hasAccountDistribution, hasFailedAccountDistribution } from "./publish-guard.ts";
import { clipGate, dispatchPublish } from "./publish-dispatch.ts";
import { basicReframeState, effectiveReframeState } from "./reframe.ts";

/**
 * AI 리프레임이 이만큼 진행이 없으면 죽은 것으로 보고 기본 크롭으로 강등한다.
 * 큐의 하트비트 만료(5분)보다 넉넉히 잡는다 — 진짜 오래 걸리는 분석을 죽이면 안 된다.
 */
const REFRAME_STUCK_MS = 30 * 60_000;

/**
 * 매 순방 마주치는 상태를 설명하는 문구들 — **문구가 곧 dedupe 키**라 상수로 못박는다.
 * hasRunNote 에 detail 까지 넘기지 않으면, 같은 (규칙·클립·채널) 키로 쓰는 다른 스킵 사유
 * (리프레임 강등·메타 대기 등)가 이미 한 줄 남아 있을 때 이 사유가 **한 줄도 안 남는다** —
 * 침묵 쪽으로 실패하는 가드는 이 파일이 고치려는 병 그 자체다.
 */
const RENDER_WAIT_NOTE = "렌더 대기 — 완료되면 다음 확인 때 자동으로 게시됩니다.";
const META_WAIT_NOTE = "메타데이터 생성 대기 — 완료되면 다음 확인 때 자동으로 게시됩니다.";
const VAGUE_ACCOUNT_NOTE =
  "계정 미상 배포 기록이 있어 건너뜁니다 — 이미 나간 건이면 그대로 두고, 아니면 배포 화면에서 계정을 지정해 발행하세요.";
const REJECTED_NOTE = "사람이 거부한 건입니다 — 이 규칙으로는 나가지 않습니다.";

export interface CycleReport {
  tenantScoped: true;
  rulesEvaluated: number;
  adopted: number;
  published: number;
  held: number;
  /** 이번 순방에 렌더를 확정 실패로 넘긴 클립 수 — 워커 로그·POST /api/automation/run 응답에 실린다. */
  renderFailed: number;
  idleReason: string;
}

/** 현재 테넌트의 규칙을 한 바퀴 돈다. */
export async function runAutomationCycle(): Promise<CycleReport> {
  // 예약 순방과 사용자의 "지금 확인"/자동배포 시작이 같은 순간 들어오면 둘 다 배포 행이
  // 생기기 전 상태를 읽고 같은 영상을 두 번 큐잉할 수 있다. 큐 dedupe 는 예약 잡끼리만 막고
  // API 직접 실행은 막지 못하므로, 실제 평가 전체를 테넌트 단위로 직렬화한다. 뒤 실행은 앞
  // 실행이 만든 distribution 을 본 뒤 hasAccountDistribution 에서 건너뛴다.
  const tenantId = currentTenantId();
  return withTenantLock(`automation-cycle:${tenantId}`, runAutomationCycleLocked);
}

async function runAutomationCycleLocked(): Promise<CycleReport> {
  // 순방 심박 — **이번 순방이 실제로 돌았다**는 시각을 남긴다(화면의 "마지막 확인 N분 전 ·
  // 다음 예정" 이 이걸 읽는다). rule_run 은 dedupe·유휴 하루한줄 가드 때문에 한 줄도 안 남는
  // 순방이 흔해서 로그 최신행으론 "언제 돌았나" 를 알 수 없다. 행동에는 영향이 없다(테넌트 KV
  // 한 줄 upsert). 실패해도 순방을 막지 않는다 — 심박이 빠지는 건 표시가 낡는 것뿐이다.
  await setAutomationSetting(LAST_CYCLE_KEY, new Date().toISOString()).catch(() => {});

  // 규칙을 **먼저** 읽는다 — 아래 크레딧 로그가 "충전하면 다시 시작합니다" 라고 약속하는데,
  // 규칙이 하나도 없으면 충전해도 시작될 게 없다(지킬 수 없는 약속).
  const paused = (await getAutomationSetting("automation.paused")) === "true";
  const rules = (await listAutomationRules()) as unknown as AutomationRule[];
  const plan = planCycle({ paused, rules });

  // 크레딧 게이트 — 잔액 0 이하면 채택도 게시도 하지 않는다. 채택은 렌더(원가),
  // 게시는 업로드로 이어져 잔액 없는 워크스페이스가 자동으로 원가를 계속 쓰게 된다.
  // 사유를 리포트에 실어 GET /api/automation 이 화면에 같은 문구를 보여준다.
  if ((await creditBalance()) <= 0) {
    // 배너만으로는 부족하다 — idleReason 은 "지금 상태" 라서, 지나간 며칠에 왜 아무것도
    // 안 나갔는지를 로그만 보는 사람은 알 수 없다. rule_id 를 비우는 이유: 크레딧은
    // 워크스페이스 전체 사정이지 특정 규칙의 사유가 아니다(규칙별 패널이 아니라 전체
    // 기록 목록에 뜬다 — 그게 맞다). 순방은 15분마다 도니 KST 하루 한 줄로 막는다.
    //
    // **이번 순방에 평가할 규칙이 있을 때만 남긴다.** 예전엔 크레딧 판정이 규칙 조회보다
    // 앞이라, 자동배포를 한 번도 설정 안 한(또는 전부 꺼 둔) 워크스페이스에도 잔액 0 이면
    // 매일 한 줄씩 쌓였다 — 규칙이 없으니 충전해도 아무것도 시작되지 않는다.
    if (plan.rules.length > 0 && !(await hasRunNote(null, null, null, "skipped", true, CREDIT_STOP_NOTE))) {
      await appendRuleRun({ ruleId: null, clipId: null, result: "skipped", detail: CREDIT_STOP_NOTE });
    }
    return {
      tenantScoped: true, rulesEvaluated: 0, adopted: 0, published: 0, held: 0, renderFailed: 0,
      idleReason: CREDIT_IDLE_REASON,
    };
  }

  const report: CycleReport = {
    tenantScoped: true,
    rulesEvaluated: plan.rules.length,
    adopted: 0,
    published: 0,
    held: 0,
    renderFailed: 0,
    idleReason: plan.idleReason,
  };
  if (plan.rules.length === 0) return report;

  // 이 테넌트의 회차·추천만 읽는다(RLS 가 가둔다).
  const episodes = await listEntities<any>("episode");
  const recommendations = await listEntities<any>("recommendation");
  const media = await listMedia();
  // 이미 만들어진 클립 전부 — top3 의 "회차당 3건" 상한을 세는 근거다. 채택하면 추천이
  // pending 풀에서 빠지므로, 클립 쪽에서 세지 않으면 순방마다 새 상위 3건이 또 뽑힌다.
  const allClips = await listEntities<any>("clip");
  const adoptedCountFor = (ruleId: string, episodeId: string): number =>
    allClips.filter((c) => c.automationRuleId === ruleId && c.episodeId === episodeId).length;

  // 규칙별 유휴 사유 — **배너(report.idleReason)는 순방 전체의 사실**이라 여기 모아 두고
  // 루프가 끝난 뒤에 판단한다. 규칙 하나가 유휴라고 전체 배너를 덮으면, 다른 규칙이 3건
  // 채택·2건 게시한 순방에도 "회차가 없습니다" 가 뜬다.
  const idleReasons: string[] = [];

  for (const rule of plan.rules) {
    const programs = rulePrograms(rule);
    const channels = ruleChannels(rule);
    const win = ruleWindow(rule);

    // 이 규칙이 이번 순방에 실행 로그를 한 줄이라도 **실제로 남겼는가.** 규칙 루프 안의 모든
    // appendRuleRun 은 아래 note() 를 지나야 한다 — 직접 부르는 게 하나라도 남으면
    // "아무 일도 안 했다" 오진이 나서 엉뚱한 사유가 로그에 박힌다(스캔 테스트가 강제).
    let logged = false;
    /**
     * dedupe 에 걸려 **아무것도 안 쓴 순방은 "말했다" 가 아니다.** 예전엔 여기서 무조건
     * logged 를 세웠는데, 평생 dedupe(todayKstOnly=false)를 쓰는 문구(렌더 확정 실패·렌더
     * 대기·계정 미상)가 한 번 걸리면 그 규칙은 **그 뒤로 영원히** 유휴 사유를 못 냈다.
     * 대신 눌린 상태는 obs 플래그로 아래 유휴 판정에 들어가, 규칙 단위 하루 한 줄로 이어진다.
     */
    const note = async (ev: Parameters<typeof appendRuleRun>[0], dedupe?: Promise<boolean>) => {
      if (await writeRun(ev, dedupe)) logged = true;
    };
    const obs: RuleIdleObservation = {
      outOfWindow: false, activeStart: win.start, activeEnd: win.end,
      episodes: 0, analyzed: 0, analyzing: 0, analysisFailed: 0, analysisBlocked: 0,
      pending: 0, kindMatched: 0, overlapped: 0, scoreBlocked: 0, scoreMissing: 0, cappedEpisodes: 0,
      clipsAllSent: false, adopted: 0,
      renderStopped: false, gateOff: false, publishFailed: false, heldWaiting: false,
      vagueAccount: false, channelBlocked: false, quotaDone: false,
      renderWaiting: false, metaWaiting: false,
      criterion: rule.criterion, mediaKind: rule.mediaKind,
    };
    /** 유휴 사유 판정 + 하루 한 줄 로그. 사유는 배너 후보로 모은다(dedupe 와 무관하게). */
    const idle = async () => {
      const why = await noteRuleIdle(rule, obs);
      if (why) idleReasons.push(why);
    };

    // 활동 시간창(KST · 기본 9~22) 밖에서는 아무것도 하지 않는다 — 다음 순방에 다시 본다.
    // 예전엔 여기서 로그가 **0줄**이라 하루 11~14시간이 통째로 비었다: 아침에 "밤새 올린
    // 회차가 왜 안 나갔지" 를 볼 때 순방이 안 돈 건지 워커가 죽은 건지 구분할 근거가 없었다.
    const explicitSlots = ruleSlots(rule);
    const slotQueueReady = explicitSlots.length > 0 && slotsReadyForQueue(explicitSlots);
    if (!inActiveWindow(rule)) {
      // A slot may be queued two hours early even when that early queue time
      // is outside the display activity window.
      if (!slotQueueReady) {
        obs.outOfWindow = true;
        await idle();
        continue;
      }
    }
    // 발행 요일이 아닌 날도 마찬가지다 — 편성이 "월화수목금" 인데 토요일에 나가면 채널
    // 성격이 흐려진다. 요일 미지정 규칙은 매일이라 여기서 걸리지 않는다(기존 동작).
    if (!isPublishDay(rule)) {
      obs.offDay = true;
      obs.weekdays = ruleWeekdays(rule);
      await idle();
      continue;
    }
    // 렌더 요청은 **클립당 순방 한 번**이다. 아래 게시 루프는 채널마다 도니, 이 가드가
    // 없으면 채널 N개 = 순방당 export N회 — 실패 카운터가 채널 배수로 부풀어 첫 순방에
    // 바로 확정 실패가 난다. 채택 직후 건 렌더도 여기 넣어 같은 순방에 두 번 때리지 않는다.
    const renderTried = new Set<string>();

    // 01 회차 수신 — 이 규칙의 프로그램(들) 회차만.
    const eps = episodes.filter((e) => programs.includes(e.programId));
    obs.episodes = eps.length;
    if (eps.length === 0) {
      await idle();
      continue;
    }

    // ── 03 미디어 생성 — 프로그램 전체에서 규칙 조건을 통과한 추천을 채택한다 ──
    for (const ep of eps) {
      // 02 분석 — 끝나지 않았으면 다음 순방에 다시 본다. 판정은 순수 함수 한 벌
      // (episodeAnalysisState)에 맡긴다: "분석 중" 과 "**큐잉조차 안 됨**" 을 여기서
      // 눈대중으로 가르면 오지 않을 완료를 기다리라는 말이 나간다.
      const state = episodeAnalysisState(ep.pipeline);
      if (state === "blocked") { obs.analysisBlocked += 1; continue; }
      if (state === "analyzing") { obs.analyzing += 1; continue; }
      // 분석이 error 로 끝난 회차는 추천이 안 생긴다. 이걸 안 세면 후보 0건이 그냥
      // "추천이 없습니다" 로 읽혀 **틀린 사유**가 나간다 — 진짜 원인은 분석 실패다.
      // (error 라도 체크포인트로 일부 추천이 남았을 수 있어 아래 스캔은 계속한다.)
      if (state === "failed") obs.analysisFailed += 1; else obs.analyzed += 1;

      // 이 회차의 기존 클립(수동 채택 포함)과 구간이 겹치는 추천은 제외 — 재분석이
      // 추천을 새 ID 로 다시 만들어도 이미 내보낸 구간이 재채택되지 않게(중복 배포 방지).
      //
      // 단계를 나눠 세는 이유: 어디서 몇 개가 떨어졌는지 모르면 "추천이 없습니다" 라는
      // 뭉뚱그린 사유밖에 못 남긴다. 술어가 서로 독립이라 **집합 결과는 예전과 같다**
      // (selectCandidates 가 pending·종류를 다시 걸러도 멱등이다).
      const epClips = allClips.filter((c) => c.episodeId === ep.id);
      const epRecs = recommendations.filter((r) => r.episodeId === ep.id);
      const pend = epRecs.filter((r) => (r.status ?? "pending") === "pending");
      obs.pending += pend.length;
      const kindOk = pend.filter((r) => matchesMediaKind(rule, r));
      obs.kindMatched += kindOk.length;
      const cands = kindOk.filter((r) => !overlapsExistingClip(r, epClips));
      obs.overlapped += kindOk.length - cands.length;
      // top3 는 회차당 상한 — 이 규칙이 이 회차에서 이미 채택한 수를 빼고 뽑는다.
      const already = adoptedCountFor(rule.id, ep.id);
      const atCap = rule.criterion === "top3" && already >= TOP3_CAP;
      if (atCap) obs.cappedEpisodes += 1;
      const pickedIds = new Set(selectCandidates(rule, cands, already).map((r) => r.id));
      const picked = cands.filter((r) => pickedIds.has(r.id));
      // 상한에 닿은 회차의 탈락분은 "기준 미달" 이 아니라 상한 탓이다 — 섞으면 사유가 뒤바뀐다.
      if (!atCap) {
        obs.scoreBlocked += cands.length - picked.length;
        // 점수가 **없는** 탈락분은 기준을 바꿔도 안 잡힌다(selectCandidates 가 세 기준 모두에서
        // 뺀다) — 재분석해야 풀린다. 따로 세지 않으면 유휴 사유가 못 지킬 조치를 안내한다.
        obs.scoreMissing += cands.filter((r: any) => typeof r.score100 !== "number").length;
      }

      for (const rec of picked) {
        const master = media.find((m: any) => m.episodeId === rec.episodeId && m.role === "master") as any;
        const clipId = newId("c");
        // 무인 렌더 시드 — factory 와 동일한 기본 모양 (규칙의 templateId·layout 최우선).
        const { autoEditorState } = await import("./factory.ts");
        const program = ep.programId ? await getEntity<any>("program", ep.programId) : undefined;
        // 채택 형태 — 규칙의 방향 선택을 **수동 채택(adopt 라우트)과 같은 매핑**으로 클립에
        // 적용한다. 미지정이면 기존처럼 추천 kind 로 결정(하위호환 · 리프레임 OFF 시 불변).
        // 클립(롱폼)은 **가로형이 기본**이다(사용자 확정 2026-08-16) — 본편 화면비를 유지한다.
        // 규칙이 방향을 명시했으면 그게 우선, 아니면 추천 종류로 정한다.
        const landscape = rule.orientation === "landscape"
          || (rule.orientation !== "portrait" && rec.kind !== "short");
        const aspectRatio = landscape ? "16:9" : "9:16-crop-main";
        const clip = {
          id: clipId,
          episodeId: rec.episodeId,
          programTitle: ep.programTitle ?? "",
          title: rec.title,
          titleLine1: rec.titleLine1,
          titleLine2: rec.titleLine2,
          hookQuote: rec.hookQuote,
          hookTimeSec: rec.hookTimeSec,
          hookIntroCaption: rec.hookIntroCaption,
          clipType: rec.kind === "short" ? "T6" : "TZ",
          targetAge: ep.targetAge ?? 0,
          aspectRatio,
          durationSec: Math.max(1, rec.endTime - rec.startTime),
          synopsis: rec.editNote ?? undefined,
          status: "editing",
          rendered: false,
          startTime: rec.startTime,
          endTime: rec.endTime,
          sourceMediaId: master?.id,
          sourceRecommendationId: rec.id,
          beatIds: Array.isArray(rec.beatIds) ? rec.beatIds : [],
          distributions: [],
          /** 어느 규칙이 만든 미디어인지 — 사고 추적·롤백 대상 선별에 쓴다. */
          automationRuleId: rule.id,
          editorState: {
            ...autoEditorState(rec, ep.programTitle ?? "", program,
              (rule as any).templateId, (rule as any).layout, aspectRatio),
            // 자막 on/off — 규칙 기본 ON(true · 하위호환). layout.subtitles === false 일 때만 끈다.
            // autoEditorState 는 captionsOn:false 를 시드하지만(공장 경로 · 번인 겹침 방지), 자동배포는
            // 규칙 토글을 따른다 — 드라마처럼 원본 번인 자막이 있는 회차는 규칙에서 자막을 끈다.
            captionsOn: rule.layout?.subtitles !== false,
            // editorState.aspect 를 clip.aspectRatio(위 5-값 enum) 와 **일치**시킨다. 위 factory에도
            // 같은 값을 넘겨 제목 106/107px의 basis 계산부터 최종 방향과 맞춘다. /export 는
            // editorState.aspect 를 최우선으로 읽으므로 여기에도 명시해 계약을 고정한다.
            aspect: aspectRatio,
          },
        };

        const ok = await commitAndInherit(clipId, clip, rec.id, rec);
        if (!ok) continue; // 다른 요청이 먼저 채택했다
        report.adopted += 1;
        obs.adopted += 1;
        // 같은 순방 안에서 top3 상한이 정확히 걸리도록 로컬 목록에도 반영한다.
        allClips.push(clip);
        // "렌더 대기"를 사람 말로 남긴다 — 렌더가 늦거나 실패해도 실행 로그만 보면
        // 클립이 어디까지 왔는지 보이게. 조용한 스킵(not_rendered 무한 반복)의 해독제다.
        await note({
          ruleId: rule.id, clipId, result: "media_created",
          detail: `${rec.title} — 클립 생성 · 렌더 대기`,
        });
        // 채널별 메타데이터 생성 — 수동 채택(adopt 라우트)과 같은 배선. 안 걸면 자동
        // 클립은 clip.title 폴백으로만 나간다(프로그램 제목 프롬프트·태그 미반영).
        await enqueue("clip.metadata", { clipId }, { dedupeKey: `clip.metadata:${clipId}` }).catch(() => {});
        // 클립(롱폼)은 **커스텀 썸네일이 있어야 클릭이 난다** — 쇼츠는 유튜브가 프레임을
        // 쓰지만 일반 영상은 썸네일이 곧 클릭률이다. 썸네일 생성 기능(thumbnail.generate)을
        // 회차 단위로 한 번 걸어 둔다(dedupe 로 회차당 1회). 게시를 막지는 않는다 —
        // 등록 출연자 사진이 없으면 이 잡은 실패하는데, 그때는 렌더 프레임으로 나간다
        // (resolveClipThumbnail 의 3단 폴백). 썸네일 때문에 배포가 멈추는 게 더 나쁘다.
        if (landscape && master?.id && ep.programId) {
          // 방식은 **규칙이 정한다**(0041). 미지정이면 frame — ai 는 등록 출연자 사진이
          // 있어야 하는데 아카이브 회차는 대개 안 채워져 있어 한 장도 못 만든다.
          // frame 은 실제 화면이라 인물 등록 없이도 되고 얼굴이 원본 그대로다.
          const thumbMode = isRuleThumbnailMode((rule as any).thumbnailMode)
            ? (rule as any).thumbnailMode : DEFAULT_RULE_THUMBNAIL_MODE;
          await enqueue("thumbnail.generate",
            { mediaId: master.id, programId: ep.programId, title: rec.title,
              mode: thumbMode, ...(thumbMode === "frame" ? { caption: rec.title } : {}) },
            { dedupeKey: `thumbnail.generate:${master.id}:${thumbMode}` }).catch(() => {});
        }
        // AI 리프레임(규칙 옵션) — 수동 채택과 같은 배선: 세로+AI 조합(store.tsx 와 같은
        // 조건식)이면 채택 직후 /clips/:id/reframe(mode=ai_multi)로 분석을 큐잉한다.
        // 리프레임→렌더 순서도 수동과 동일하다: /export 가 플랜 완료 전엔 reframe_not_ready
        // 409 로 막으므로, 큐잉에 성공한 순방엔 렌더를 걸지 않는다 — rendered:false 는
        // 아래 not_rendered 재요청 분기가 매 순방 다시 걸어 주니, 플랜이 준비된 순방에
        // 자동으로 렌더→게시로 이어진다(새 조율 로직 없음). 큐잉 실패면 수동 실패와 같은
        // 폴백 — 기본(중앙 크롭) 렌더로 진행한다.
        const wantsAiReframe = rule.orientation === "portrait" && rule.reframe === "ai";
        if (!(wantsAiReframe && await requestAutoReframe(clipId))) {
          // 채택 즉시 렌더를 건다 (아래 requestAutoRender). 여기서 안 걸면 클립이
          // rendered:false 로 남아 eligibility(not_rendered)에 매 순방 걸리고 자동 게시가
          // 영원히 0건이다 — 어떤 경로도 렌더를 요청하지 않았기 때문(2026-08-14 확정).
          // 안전벨트의 시계(firstAt)도 여기서 시작한다 — 첫 실패부터 세야 정체를 잰다.
          renderTried.add(clipId);
          await attemptAutoRender(rule.id, clip, note, report);
        }
      }
    }

    // ── 04·05 — 채널마다 **하루 할당량이 찰 때까지** 게시한다 ──────────────────
    const epIds = new Set(eps.map((e) => e.id));
    const mine = (await listEntities<any>("clip")).filter(
      (c) => c.automationRuleId === rule.id && epIds.has(c.episodeId),
    );
    // "만든 건 다 나갔다" 는 흔한 오진("채택할 새 추천이 없습니다")을 막는 관측치다 —
    // 게시 여부 판정은 upsertDistribution 과 같은 정체성 규칙(publish-guard)을 쓴다.
    obs.clipsAllSent = mine.length > 0 && mine.every((c) =>
      channels.every((ch) => hasAccountDistribution(c.distributions, ch.platform, ch.accountId)));

    for (const chan of channels) {
      const accountKey = `${chan.platform}:${chan.accountId}`;

      // 실업로드 게이트(env) — 순방이 미리 본다. 예전엔 안 봐서, 게이트 OFF 인데도
      // 큐잉→'published' 기록→하루 한도 차감까지 하고 워커는 전부 failed 로 만들었다
      // (다음날 재큐잉 루프). 수동 발행 라우트는 자기 409 게이트가 따로 있어 불변.
      const upGate = autoUploadGate(chan.platform);
      if (!upGate.send) {
        // 큐잉·published 기록·한도 차감 없이 사유만 남긴다 — 조용히 건너뛰면
        // "왜 안 나가지"를 아무도 모른다. 이번 순방에 보낼 게 실제로 있을 때만
        // 한 줄(채널당) 남긴다 — 매 순방 무조건 쌓으면 로그가 사유를 덮는다.
        const wouldSend = mine.some(
          (c) => !hasAccountDistribution(c.distributions, chan.platform, chan.accountId));
        if (wouldSend) {
          obs.gateOff = true;
          // **하루 한 줄 가드가 필수다.** 게이트 OFF 는 env 를 고치기 전엔 안 변하는 상태라,
          // 활동시간 9~22시 · 15분 주기면 (규칙,채널)당 하루 52줄이 쌓여 실행 로그 창(50건)을
          // 이 줄로 덮는다 — 사유를 남기려다 정작 중요한 사유를 가리는 자충수다.
          await note({ ruleId: rule.id, result: "skipped", detail: upGate.offNote, accountKey },
            hasRunNote(rule.id, null, accountKey, "skipped", true, upGate.offNote));
        }
        continue;
      }

      // 발행 시각 슬롯이 있으면 **지난 슬롯 수**가 지금까지 허용된 누적 발행 수다
      // (17:00·20:00·22:00 이면 20:30 에 2건). 슬롯이 없으면 예전처럼 하루 할당량.
      // 판정을 automation.ts 한 곳에 두어 화면의 월 예상 건수와 갈라지지 않게 한다.
      const slotted = ruleSlots(rule);
      const publishedToday = await publishedTodayKst(accountKey);
      // Explicit slots are queued two hours early; YouTube publishes at target time.
      const quota = slotted.length ? slotsReadyForQueue(slotted) : allowedToday(rule);
      let remaining = quota - publishedToday;
      if (remaining <= 0) {
        // 조용히 넘기면 "왜 오늘은 아무것도 안 나갔지" 를 설명할 근거가 로그에 없다.
        // 채널당 하루 한 줄만 남긴다(순방은 15분마다 돈다). 문구까지 맞춰 dedupe 하는 이유:
        // 같은 (규칙,채널,skipped,오늘) 키를 게이트 OFF 사유도 쓰므로, 문구를 안 보면
        // 오전에 게이트 OFF 로 한 줄 남은 채널에서 이 사유가 **한 줄도 안 남는다.**
        // 문구의 숫자는 규칙 설정(할당량)이라 하루 안에 저절로 안 바뀐다.
        obs.quotaDone = true;
        // ⚠️ 이 문구는 dedupe 키다 — **하루 안에 바뀌는 숫자를 넣으면 안 된다.**
        // 슬롯 방식에서는 허용치가 시각에 따라 1→2→3 으로 커지므로 그 수를 문구에 실으면
        // 슬롯마다 새 줄이 쌓여 실행 로그(50건 창)를 이 줄로 덮는다. 슬롯 규칙은 숫자를
        // 빼고 "다음 발행 시각 대기" 라는 고정 문구를 쓴다 — 의미도 그쪽이 정확하다.
        const slotted = ruleSlots(rule).length > 0;
        const quotaNote = slotted
          ? "이 시각까지의 발행을 모두 마쳤습니다 — 다음 발행 시각에 이어서 올라갑니다."
          : `오늘 이 채널 할당량(${quota}건)을 다 썼습니다 — 내일 자정(KST)에 초기화됩니다.`;
        await note({
          ruleId: rule.id, clipId: null, result: "skipped", accountKey, detail: quotaNote,
        }, hasRunNote(rule.id, null, accountKey, "skipped", true, quotaNote));
        continue; // 오늘 할당량 완료 — 내일 KST 자정에 리셋
      }

      // 채널 규칙이 없어도 배포는 가능해야 한다 (사용자 결정 2026-08-12) — 규칙은
      // 제한을 더하는 장치지 전제조건이 아니다. 없으면 전부 허용 기본값.
      const channelRule = ((await getChannelRule(chan.platform, chan.accountId)) as unknown as ChannelRule | null)
        ?? ({
          platform: chan.platform, accountId: chan.accountId, label: chan.accountId,
          role: "main", maxSec: null, aspect: "any",
          titlePrefix: "", hashtagTemplate: "", tonePreset: "",
          privacy: "private", scheduleWindow: "", enabled: true,
        } as unknown as ChannelRule);

      for (const clip of mine) {
        if (remaining <= 0) break;

        // 이미 **이 계정으로** 나갔으면 건드리지 않는다(중복 게시 방지). 배포 행에
        // 계정 식별자가 없으면(구 데이터) 플랫폼 일치만으로 보수적으로 스킵한다.
        // 판정은 upsertDistribution 과 같은 정체성 규칙(publish-guard)을 공유한다 —
        // 두 벌이 되면 한쪽만 고쳐져 매 순방 재업로드가 재발한다.
        if (hasAccountDistribution(clip.distributions, chan.platform, chan.accountId)) {
          // 계정 식별자가 없는 옛 기록 때문에 스킵한 경우는 **로그를 남긴다.** 조용히 넘기면
          // "왜 이 클립만 안 나가지" 를 추적할 근거가 제품 안에 없다.
          const vague = (clip.distributions ?? []).some((d: any) =>
            d.channel === chan.platform && d.status !== "failed" && distributionAccountId(d) === null);
          if (vague) {
            obs.vagueAccount = true;
            await note({
              ruleId: rule.id, clipId: clip.id, result: "skipped", accountKey,
              detail: VAGUE_ACCOUNT_NOTE,
            }, hasRunNote(rule.id, clip.id, accountKey, "skipped", false, VAGUE_ACCOUNT_NOTE));
          }
          continue;
        }

        // 실패한 배포는 **자동으로 다시 쏘지 않는다**(F4-4). 실패 행은 위 판정에서 "안 나간
        // 것" 이라 막지 않으면 순방이 10분마다 같은 클립을 재업로드한다 — 업로드가 시작된
        // 뒤 응답만 유실된 실패면 채널에 같은 영상이 중복으로 올라간다. 사람이 배포 기록의
        // 재시도 버튼을 눌러야 다시 나간다.
        //
        // ⚠️ 여기서 `holdClip` 을 쓰면 안 된다. rule_hold 는 (규칙, 클립) 키라 **채널 개념이
        // 없어서**, 유튜브 하나 실패가 같은 규칙의 인스타·틱톡·네이버까지 영원히 막는다.
        // 게다가 사람이 승인 큐에서 풀어도 다음 순방이 released_at 을 리셋해 해제 버튼이
        // 무력해진다. 실패의 정본은 **배포 행의 status** 이므로 그걸 근거로 이 채널만 건너뛰고,
        // 사유는 채널별로 한 번만 남긴다(순방마다 쌓으면 로그가 그 줄로 덮인다).
        if (hasFailedAccountDistribution(clip.distributions, chan.platform, chan.accountId)) {
          // 이 줄도 (클립,채널)당 한 번만 남는다 — 눌린 뒤에도 "왜 이 규칙이 멈춰 있나" 는
          // 설명돼야 하므로 관측치로 이어 준다. 안 그러면 유휴 판정이 "채택할 새 추천이
          // 없습니다" 라는 엉뚱한 사유로 떨어진다(진짜 원인은 배포 실패다).
          obs.publishFailed = true;
          await note({
            ruleId: rule.id, clipId: clip.id, result: "failed", accountKey,
            detail: "직전 배포가 실패했습니다 — 자동 재시도는 하지 않습니다. 배포 기록에서 재시도를 눌러 주세요.",
          }, hasRunNote(rule.id, clip.id, accountKey, "failed"));
          continue;
        }

        // 지난 순방에서 렌더가 안 끝난(또는 실패한) 클립 — 다시 걸고, 끝났으면 이번
        // 순방에서 바로 집는다. /export 는 revision 캐시가 있어 이미 렌더된 클립의
        // 재요청은 재인코딩 없이 즉시 돌아온다(중복 렌더 방지).
        if (clip.rendered === false) {
          // AI 리프레임 분석이 failed 로 끝나면 /export 가 영원히 409(reframe_not_ready)라
          // 이 클립은 조용히 영영 미게시된다 — 무인 경로엔 재시도 누를 사람이 없다.
          // 채택 직후 큐잉 실패와 같은 결말(기본 중앙 크롭)로 낮춰 렌더를 살린다.
          const rf = effectiveReframeState(clip);
          if (rf.mode === "ai_multi" && rf.status !== "ready") {
            // failed 만 구제하면 부족하다. stale(입력 지문 불일치)·queued/running(워커가
            // 죽어 실패 기록을 못 남긴 경우)로 굳으면 /export 가 영원히 409 라 클립이 조용히
            // 영영 미게시된다 — 그런데 로그에는 "곧 자동 게시됩니다" 만 쌓여 운영자는
            // 진행 중이라 믿고 기다린다. 되살릴 수 있으면 되살리고, 정체되면 강등한다.
            const stuckMs = Date.now() - Number((rf as any).updatedAt ?? 0);
            if (rf.status === "stale" && await requestAutoReframe(clip.id)) {
              await note({
                ruleId: rule.id, clipId: clip.id, result: "skipped",
                detail: "AI 리프레임 결과가 낡아 다시 분석을 겁니다 — 끝나면 자동으로 게시됩니다.", accountKey,
              });
            } else if (rf.status === "failed" || stuckMs > REFRAME_STUCK_MS) {
              await putEntity("clip", clip.id, { ...clip, reframe: basicReframeState() });
              clip.reframe = basicReframeState();
              await note({
                ruleId: rule.id, clipId: clip.id, result: "skipped",
                detail: rf.status === "failed"
                  ? "AI 리프레임 분석 실패 — 기본(중앙 크롭)으로 렌더를 진행합니다."
                  : `AI 리프레임이 ${Math.round(stuckMs / 60000)}분째 진행이 없어 기본(중앙 크롭)으로 렌더합니다.`,
                accountKey,
              });
            }
          }
          // 확정 실패한 클립은 다시 때리지 않는다(하루 한 번만 재확인 — shouldRequestAutoRender).
          if (!renderTried.has(clip.id) && shouldRequestAutoRender(clip.autoRender, Date.now())) {
            renderTried.add(clip.id);
            if (await attemptAutoRender(rule.id, clip, note, report)) {
              const fresh = await getEntity<any>("clip", clip.id);
              if (fresh) Object.assign(clip, fresh);
            }
          }
        }

        const why = eligibility(channelRule, {
          id: clip.id, durationSec: clip.durationSec,
          aspectRatio: clip.aspectRatio, rendered: clip.rendered !== false,
        });
        if (!why.ok) {
          if (why.code === "not_rendered") {
            // ⚠️ **지킬 수 없는 약속을 멈추는 자리다.** 소스 소실·코덱 실패처럼 결정론적으로
            // 영구 실패면 "완료되면 자동으로 게시됩니다" 는 영원히 안 지켜지는데, 예전엔 그
            // 낙관 문구를 매 순방·매 채널 무가드로 쌓아 진짜 사유를 로그 창 밖으로 밀어냈다.
            if ((clip.autoRender as AutoRenderState | undefined)?.failed) {
              // accountKey 를 붙이면 안 된다 — 같은 (clip, account) 의 뒤이은 'failed' 행이
              // publishedTodayKst 의 published 슬롯을 되돌려 하루 할당량 도배 방지가 뚫린다.
              // 렌더는 채널과 무관한 클립 단위 사실이기도 하다. 문구는 고정값이라 곧 dedupe
              // 키가 된다(클립당 평생 한 줄) — 사건의 상세는 확정 순간에 이미 남겼다.
              // 평생 dedupe 라 이 줄이 눌린 뒤에도 상태가 사라지면 안 된다 → obs 로 이어 준다.
              obs.renderStopped = true;
              await note({
                ruleId: rule.id, clipId: clip.id, result: "failed", accountKey: null,
                detail: AUTO_RENDER_STOPPED_NOTE,
              }, hasRunNote(rule.id, clip.id, null, "failed", false, AUTO_RENDER_STOPPED_NOTE));
              continue;
            }
            // 아직 살아 있는 렌더 — not_rendered 의 기본 문구는 수동 화면용("내보내기 후…")
            // 이라 자동 경로에선 오독된다. 사람이 할 일이 없음을 말하되 (클립,채널)당 한 줄만.
            obs.renderWaiting = true;
            await note({
              ruleId: rule.id, clipId: clip.id, result: "skipped", accountKey,
              detail: RENDER_WAIT_NOTE,
            }, hasRunNote(rule.id, clip.id, accountKey, "skipped", false, RENDER_WAIT_NOTE));
            continue;
          }
          // 채널 규칙(길이·화면비) 미달 — 클립을 고치거나 규칙을 바꾸기 전엔 안 변하는 상태라
          // 무가드로 두면 매 순방·매 채널 같은 줄이 쌓인다. 문구가 곧 dedupe 키다.
          obs.channelBlocked = true;
          await note({ ruleId: rule.id, clipId: clip.id, result: "skipped", detail: why.reason, accountKey },
            hasRunNote(rule.id, clip.id, accountKey, "skipped", false, why.reason));
          continue;
        }

        // 사람이 **거부**한 (규칙·영상)은 재선정도 게시도 하지 않고 건너뛴다(0044). released_at
        // 과 별개 상태라 approve_first 게이트를 건드리지 않는다(거부가 되레 게시되는 사고 방지).
        // (규칙,클립)당 사실이라 문구 고정 = dedupe 키 → 채널·순방마다 안 쌓인다.
        if (await isRejectedHold(rule.id, clip.id)) {
          await note({ ruleId: rule.id, clipId: clip.id, result: "skipped", accountKey: null, detail: REJECTED_NOTE },
            hasRunNote(rule.id, clip.id, null, "skipped", false, REJECTED_NOTE));
          continue;
        }

        const gate = await clipGate(clip.id);
        const held = await isHeldAwaitingHuman(rule.id, clip.id);
        // 승인 정책은 사람의 보류 해제를 승인으로 본다 — 별도 승인 버튼을 또 만들지 않는다.
        // 단, 근거는 **해제 기록**(released_at)이어야 한다. `!held` 를 승인으로 쓰면
        // 보류된 적 없는 새 클립까지 자동 승인되어 approve_first 가 무력화된다.
        const approved = await hasReleasedHold(rule.id, clip.id);
        const decision = decidePublish({
          rule,
          gate: { allowed: gate.allowed, state: gate.state, reason: gate.reason },
          approved,
          heldAwaitingHuman: held,
        });

        if (decision.action === "hold") {
          // ⚠️ **이미 열린 보류는 다시 쓰지 않는다.** holdClip 은 ON CONFLICT DO UPDATE 로 사유를
          // 덮는데, 한 번 보류된 뒤로는 decidePublish 가 "보류 상태입니다 — 사람이 확정해야…"
          // 라는 동어반복만 돌려준다. 그대로 덮으면 두 번째 순방부터 **최초 사유(권리 확인 등)가
          // 지워져** 승인 대기 화면이 왜 멈춰 있는지 말해주지 못한다(2026-08-19). 새 보류일 때만 쓴다.
          if (!held) await holdClip(rule.id, clip.id, decision.reason);
          // 보류는 **사람이 확정할 때까지 유지되는 상태**다(F6 Invariant) — 무가드로 두면
          // 승인 대기 건 하나가 15분마다 한 줄씩, 하루 90여 줄을 쌓아 로그 창을 덮는다.
          // 사유가 곧 dedupe 키라 보류 사유가 바뀌면 새 줄이 남는다.
          obs.heldWaiting = true;
          await note({ ruleId: rule.id, clipId: clip.id, result: "held", detail: decision.reason, accountKey },
            hasRunNote(rule.id, clip.id, accountKey, "held", false, decision.reason));
          report.held += 1;
          continue;
        }
        if (decision.action === "skip") continue;

        // 채널별 메타 없이 게시하지 않는다 — 워커 metaForChannel 폴백(clip.title)으로
        // 나가면 제목 프롬프트·채널별 태그가 미반영된 채 실업로드된다(제목 해시태그도 없다).
        //
        // 없으면 **이 자리에서 즉석 생성**한다(requestAutoMetadata · 내부 POST). 예전엔
        // clip.metadata 잡만 큐잉하고 순방을 통째로 넘겨 다음 순방(최대 15분 뒤)에야 게시됐다 —
        // 이제는 같은 순방에 생성→게시로 잇는다. 생성은 (클립,채널)당 **한 번만** — channelMeta 가
        // 이미 있으면 건너뛴다(멱등 · Gemini 원가 반복 방지). generate-metadata 는 전 채널을 한 번에
        // 만들므로 한 클립에 실제 Gemini 호출은 첫 채널에서 1회뿐이다.
        let chanMeta = (clip as any).channelMeta?.[chan.platform];
        if (!chanMeta || !(chanMeta.title || chanMeta.description)) {
          if (await requestAutoMetadata(clip.id, chan.platform)) {
            // 성공하면 방금 저장된 channelMeta 를 최신 행에서 다시 읽어 이번 순방에 바로 게시한다.
            const fresh = await getEntity<any>("clip", clip.id);
            if (fresh) { Object.assign(clip, fresh); chanMeta = (fresh as any).channelMeta?.[chan.platform]; }
          }
        }
        if (!chanMeta || !(chanMeta.title || chanMeta.description)) {
          // 즉석 생성이 실패했다(대개 입력 부족·모델 오류). **게시를 막아 폴백 제목으로 나가는 걸
          // 방지**하되, 잡을 (재)큐잉해 두고 이번 순방은 이 채널만 넘긴다 — dedupe 는
          // pending/running 에만 걸리므로 잡이 실패했어도 다음 순방이 다시 큐잉한다(조용한 영구
          // 정지 없음). requestAutoMetadata 는 던지지 않으므로 순방 전체는 막히지 않는다.
          await enqueue("clip.metadata", { clipId: clip.id }, { dedupeKey: `clip.metadata:${clip.id}` }).catch(() => {});
          // 렌더 대기와 같은 처방 — 잡이 계속 실패하면 이 상태가 며칠 이어질 수 있어
          // 무가드면 (클립,채널)당 하루 90여 줄이다. 재큐잉은 위에서 매 순방 계속한다.
          obs.metaWaiting = true;
          await note({
            ruleId: rule.id, clipId: clip.id, result: "skipped",
            detail: META_WAIT_NOTE, accountKey,
          }, hasRunNote(rule.id, clip.id, accountKey, "skipped", false, META_WAIT_NOTE));
          continue;
        }

        // 05 게시 — 사람이 누르는 배포와 **같은 관문**을 지난다(F6 Invariant).
        // 네이버는 설명이 필수(클립 10자) — 자동 경로에서는 클립 시놉시스/제목으로 채운다.
        const isNaver = chan.platform === "navertv" || chan.platform === "naverclip";
        const desc = String(clip.synopsis ?? clip.title ?? "").trim();
        const outcome = await dispatchPublish({
          clipIds: [clip.id],
          channel: chan.platform,
          // 계정 식별자는 플랫폼에 맞는 필드로만 — 배포 행의 계정 정체성
          // (distributionAccountId)이 이 필드로 판정된다. 규칙 channels[] 의 accountId 를
          // 플랫폼별 필드로 푼다 — 예전엔 youtube/naver 만 넘겨서 TikTok·IG·FB 는 계정
          // 지정 없는 배포(추론 금지 → record 강등·정체성 없는 행)가 됐다.
          ...(chan.platform === "youtube" ? { youtubeChannelId: chan.accountId } : {}),
          ...(chan.platform === "tiktok" ? { tiktokOpenId: chan.accountId } : {}),
          ...(chan.platform === "instagram" ? { igUserId: chan.accountId } : {}),
          ...(chan.platform === "facebook" ? { metaPageId: chan.accountId } : {}),
          ...(isNaver ? {
            naverAccountId: chan.accountId,
            // 패딩 문구는 단독으로도 10자 이상이어야 한다 — 네이버 클립 최소 설명 길이가
            // 10자라서, 시놉시스가 비어 있으면 패딩만으로 통과해야 워커 단 실패가 없다.
            description: desc.length >= 10 ? desc : `${desc} 방송 하이라이트 클립입니다`.trim(),
            naverCategory: { primary: "엔터", secondary: "엔터" },
          } : {}),
          // ⚠️ **공개 범위를 반드시 넘긴다.** 안 넘기면 워커가 "public" 으로 폴백해서,
          // 방송사 회차에서 뽑은 클립이 사람 눈을 한 번도 안 거치고 전체공개로 나간다
          // (되돌리려면 채널에서 직접 내려야 하고 노출 이력은 남는다). 채널 규칙에 값이
          // 있으면 그걸 따르고, 없으면 **unlisted** 로 올린다 — 자동 경로의 기본값은
          // "링크 아는 사람만" 이어야 하고, 전체공개는 사람이 정하는 일이다.
          ...(chan.platform === "youtube" ? youtubeReleasePlan(
            channelRule,
            slotted.length ? scheduledSlotAt(slotted, publishedToday + (quota - remaining)) : null,
          ) : {}),
          actor: `automation:${rule.id}`,
          // "factory"(외부 공장 API)와 구분되는 자동 순방 표식 — 화면의 자동/수동 배지가 읽는다.
          origin: "automation",
        });

        if (outcome.skipped.length > 0) {
          const reason = outcome.skipped[0].reason;
          await holdClip(rule.id, clip.id, reason);
          await note({ ruleId: rule.id, clipId: clip.id, result: "held", detail: reason, accountKey });
          report.held += 1;
        } else {
          const published = outcome.queued.length > 0;
          if (published) remaining -= 1;
          report.published += published ? 1 : 0;
          await note({
            ruleId: rule.id, clipId: clip.id,
            result: published ? "published" : "recorded",
            // 게이트 OFF 로 record 강등된 채널(TikTok·IG·FB)은 그 사실을 로그에 박는다 —
            // '기록됨'만 보면 게이트 문제인지 채널 성격인지 구분이 안 된다.
            detail: upGate.recordOnly ? `${upGate.offNote} · ${outcome.notice}` : outcome.notice,
            accountKey,
          });
        }
      }
    }

    // 이 규칙이 한 줄도 안 남겼으면 **왜 아무 일도 없었는지**를 남긴다. 조용한 정지는
    // 이 리포의 최빈 실패모드다 — 규칙은 "실행 중" 인데 아무것도 안 나가는 상태를
    // 사용자가 추리하게 두지 않는다.
    if (!logged) await idle();
  }

  // 배너(idleReason)는 **순방 전체**의 필드다. 규칙 하나의 사유를 여기 얹으면, 규칙 A 가
  // 3건 채택·2건 게시한 순방에도 규칙 B 탓에 "회차가 없습니다" 가 화면에 뜬다.
  // 그래서 조건은 둘: (1) 이번 순방이 정말 아무 일도 안 했고(채택·게시·보류 0),
  // (2) 평가한 규칙이 **전부** 유휴여야 한다. 대표는 첫 규칙의 사유 하나만 싣는다 —
  // 배너에 여러 줄을 늘어놓으면 어디부터 손대야 할지 모른다(사유는 로그에 규칙별로 남는다).
  if (!report.idleReason
    && report.adopted === 0 && report.published === 0 && report.held === 0
    && idleReasons.length > 0 && idleReasons.length === plan.rules.length) {
    report.idleReason = idleReasons[0];
  }

  return report;
}

/**
 * 실행 로그 한 줄 — dedupe 판정이 참이면 쓰지 않는다. **실제로 썼는지**를 돌려준다.
 *
 * 규칙 루프 안에서는 **반드시 note() 를 거쳐야** 하므로(logged 플래그) 실제 쓰기는 여기로
 * 뺐다. 루프 안에 appendRuleRun 직접 호출이 하나라도 남으면 "아무 일도 안 했다" 오진이
 * 나서 엉뚱한 사유가 로그에 박힌다 — 스캔 테스트가 그 재발을 막는다.
 */
async function writeRun(
  ev: Parameters<typeof appendRuleRun>[0], dedupe?: Promise<boolean>,
): Promise<boolean> {
  if (dedupe && await dedupe) return false;
  await appendRuleRun(ev);
  return true;
}

/**
 * 규칙 하나가 아무 일도 안 한 사유 — **판정은 항상 하고, 로그만 하루 한 줄로 막는다.**
 * 사유 문구를 돌려준다(배너 후보). 일을 했으면 null.
 *
 * ⚠️ 예전엔 dedupe 에 걸리면 여기서 곧장 return 이라 **배너까지 같이 건너뛰었다** — 그래서
 * 그날 첫 순방에만 배너가 차고, 이후 "지금 확인" 버튼은 유휴인데도 초록색 "규칙 1개 ·
 * 미디어 0" 만 보여줬다. 로그(하루 1줄)와 배너(매번)는 주기가 다른 별개의 소비처다.
 *
 * 스팸 방지는 **문구 자체가 dedupe 키**다(KST 하루 한 줄). 순방은 15분마다 도니 가드가
 * 없으면 규칙 하나가 하루 90여 줄을 쌓아, 화면이 보여주는 최근 50건이 이 줄로만 덮인다 —
 * 사유를 남기려다 정작 중요한 사유를 가리는 자충수가 된다.
 */
/**
 * YouTube 공개 계획 — 공개 범위 + **공개 유예**를 dispatchPublish 입력으로 푼다.
 *
 * ⚠️ **공개 범위를 반드시 넘긴다.** 안 넘기면 워커가 "public" 으로 폴백해서, 방송사 회차에서
 * 뽑은 클립이 사람 눈을 한 번도 안 거치고 전체공개로 나간다(되돌리려면 채널에서 직접 내려야
 * 하고 노출 이력은 남는다). 채널 규칙에 값이 있으면 그걸 따르고, 없으면 **unlisted** 로
 * 올린다 — 자동 경로의 기본값은 "링크 아는 사람만" 이어야 하고, 전체공개는 사람이 정한다.
 *
 * 공개 유예(publishDelayMin)는 **목표가 public 일 때만** 건다. 유튜브 `publishAt` 예약은
 * private 로 잡아뒀다가 **공개로 끝나므로**, unlisted/private 목표에 걸면 운영자가 정한
 * 공개 범위를 조용히 바꿔 버린다. 유예의 값은 처리 완료(HD 트랜스코딩·커스텀 썸네일)를
 * 첫 노출 전에 끝내는 데 있다 — 근거는 channel-rules.ts 의 publishDelayMin 주석.
 */
function youtubeReleasePlan(channelRule: unknown, targetAt: Date | null = null): {
  privacy: "public" | "unlisted" | "private";
  scheduled?: boolean;
  reserveDate?: string;
} {
  const raw = (channelRule as { privacy?: unknown; publishDelayMin?: unknown } | null | undefined) ?? {};
  const privacy = (["public", "unlisted", "private"] as const).includes(raw.privacy as never)
    ? (raw.privacy as "public" | "unlisted" | "private")
    : "unlisted";
  if (privacy !== "public") return { privacy };
  if (targetAt && targetAt.getTime() > Date.now()) {
    return { privacy, scheduled: true, reserveDate: targetAt.toISOString() };
  }
  const delayMin = normalizePublishDelayMin(raw.publishDelayMin);
  if (delayMin <= 0) return { privacy };
  // 예약 시각은 **5분 격자로 올림**한다 — 유튜브 예약이 격자를 벗어난 시각을 거부·보정하는
  // 사례가 있다(사용자 2026-08-20). 올림이라 실제 유예는 설정값 이상이 된다.
  // ISO(Z) 로 넘긴다 — normalizeReserveDate 는 오프셋 없는 문자열을 KST 로 해석하므로,
  // 여기서 명시적 UTC 를 주면 해석 여지가 없다.
  const at = nextPublishSlot(Date.now() + delayMin * 60_000);
  return { privacy, scheduled: true, reserveDate: at.toISOString() };
}

async function noteRuleIdle(
  rule: AutomationRule, obs: RuleIdleObservation,
): Promise<string | null> {
  const idle = ruleIdleNote(obs);
  if (!idle) return null;
  if (!(await hasRunNote(rule.id, null, null, "skipped", true, idle.detail))) {
    await appendRuleRun({ ruleId: rule.id, clipId: null, result: "skipped", detail: idle.detail });
  }
  return idle.detail;
}

/**
 * 채널별 실업로드 게이트(env) 스냅샷 — 자동 경로 전용 판정.
 *
 * - youtube·naver 는 channelPublishMode 가 **항상 upload** 라, 게이트 OFF 인 채로 큐잉하면
 *   워커가 전부 failed 로 만든다(순방은 이미 'published' 기록+한도 차감). → send:false 로
 *   순방이 아예 보내지 않는다.
 * - tiktok·instagram·facebook 은 게이트 OFF 면 dispatchPublish 가 record 모드로 기록만
 *   남긴다 — 그건 record_only 규칙의 제품 동작("배포 기록만 남습니다")이라 막지 않고,
 *   recordOnly 표시로 실행 로그에 '기록만 됨'을 명시한다.
 * - 모르는 플랫폼은 보낸다(dispatchPublish 의 channel_unsupported 가 사유와 함께 거른다 —
 *   여기서 또 거르면 거절 사유가 두 벌이 된다).
 */
function autoUploadGate(platform: string): { send: boolean; recordOnly: boolean; offNote: string } {
  const on = { send: true, recordOnly: false, offNote: "" };
  // ⚠️ 사용자 문구에 env 이름을 넣지 않는다 — 운영자가 할 수 있는 조치가 아니다(서버 설정).
  // 어느 env 인지는 아래 switch 와 upload-gate.ts·CLAUDE.md 가 정본이다.
  const blocked = () => ({
    send: false, recordOnly: false,
    offNote: "실제 업로드가 꺼져 있어 이 채널로 보내지 않았습니다 — 담당자에게 업로드 설정을 켜 달라고 요청해 주세요. 켜지면 다음 확인 때 게시합니다.",
  });
  const recordOnly = () => ({
    send: true, recordOnly: true,
    offNote: "실제 업로드가 꺼져 있어 기록만 남겼습니다 — 담당자에게 업로드 설정을 켜 달라고 요청해 주세요.",
  });
  switch (platform) {
    case "youtube": return youtubeUploadEnabled() ? on : blocked();
    case "navertv":
    case "naverclip": return naverUploadEnabled() ? on : blocked();
    case "tiktok": return tiktokUploadEnabled() ? on : recordOnly();
    case "instagram": return instagramUploadEnabled() ? on : recordOnly();
    case "facebook": return facebookUploadEnabled() ? on : recordOnly();
    default: return on;
  }
}

/**
 * 렌더 요청 — factory 의 requestExport 와 같은 경로(POST /api/clips/:id/export · 내부 인증).
 * 렌더 로직이 서버 라우트에 있는 이유(자막·훅 프리롤·썸네일 오버레이가 전부 거기)는
 * factory.ts 렌더 단계 주석과 같다 — 워커에서 복제하면 두 벌이 갈라진다.
 *
 * 던지지 않는다: 실패한 렌더는 다음 순방의 not_rendered 분기가 다시 요청한다 — 단
 * **영원히는 아니다**(attemptAutoRender 의 안전벨트). 실패를 boolean 으로 삼키면 사유도
 * 횟수도 어디에도 안 남아, 소스 소실 같은 영구 실패에 "곧 게시됩니다" 를 무한히 약속하게 된다.
 * 중복 렌더 방지(dedupe)는 두 겹 — (1) 순방 잡 자체가 automation.cycle:{tenantId}
 * dedupeKey 로 테넌트당 직렬이고, (2) /export 는 revision 캐시가 있어 이미 렌더된
 * 클립의 재요청은 재인코딩 없이 즉시 돌아온다.
 */
async function requestAutoRender(clipId: string): Promise<RenderOutcome> {
  try {
    const { apiBase, internalHeaders } = await import("./factory.ts");
    const res = await fetch(`${apiBase()}/api/clips/${clipId}/export`, {
      method: "POST", headers: await internalHeaders(),
    });
    if (res.ok) return { ok: true };
    // 라우트가 code/error/message 로 사유를 준다 — 이걸 안 읽으면 "리프레임 대기" 와
    // "원본 소실" 이 같은 실패로 뭉뚱그려져 멀쩡한 클립이 확정 실패로 죽는다.
    const body = await res.json().catch(() => ({} as any)) as any;
    const code = typeof body?.code === "string" ? body.code : (typeof body?.error === "string" ? body.error : null);
    const msg = String(body?.message ?? body?.error ?? `export ${res.status}`);
    console.warn(`[automation] 렌더 요청 실패 ${clipId}: ${res.status} ${msg.slice(0, 160)}`);
    // status·code 를 함께 싣는다 — 사람이 읽는 사유(renderFailureReason)의 근거다.
    // 영어 원문(error)은 상태에만 남고 실행 로그 문구에는 절대 안 들어간다.
    return {
      ok: false, kind: classifyRenderFailure(res.status, code),
      error: `${res.status} ${msg}`, status: res.status, code,
    };
  } catch (e) {
    // 네트워크·타임아웃은 복구될 수 있다 — retryable(상태 0 은 어떤 HTTP 코드도 아니다).
    console.warn(`[automation] 렌더 요청 실패 ${clipId}: ${String(e).slice(0, 160)}`);
    return {
      ok: false, kind: classifyRenderFailure(0, null),
      error: String(e).slice(0, 160), status: 0, code: null,
    };
  }
}

/**
 * 렌더 요청 + 안전벨트. AI 리프레임의 30분 정체 강등(REFRAME_STUCK_MS)과 같은 처방을
 * 렌더에 건다 — 다만 강등할 대안이 없으니 **확정 실패로 넘겨 사람에게 알린다.**
 *
 * 상태는 실행 로그가 아니라 **클립 엔티티(`autoRender`)** 에 둔다. 실행 로그는 hasRunNote 로
 * 일부러 중복을 안 남기는 사건 기록이라 횟수를 셀 수 없고, 화면에도 최근 50건만 남는다.
 * 로그=사건, 엔티티=상태. 클립에 자동화 소유 필드(automationRuleId)와 리프레임 상태
 * (clip.reframe)가 이미 사는 것도 같은 이유다.
 */
async function attemptAutoRender(
  ruleId: string,
  clip: any,
  note: (ev: Parameters<typeof appendRuleRun>[0], dedupe?: Promise<boolean>) => Promise<void>,
  report: CycleReport,
): Promise<boolean> {
  const clipId = String(clip.id);
  const now = Date.now();
  const prev = (clip.autoRender ?? null) as AutoRenderState | null;
  const outcome = await requestAutoRender(clipId);
  const next = nextAutoRenderState(prev, outcome, now);

  if (JSON.stringify(prev ?? null) !== JSON.stringify(next ?? null)) {
    // putEntity 는 클립 JSON 전체를 덮는다 — /export 가 방금 쓴 rendered:true·mediaId 를
    // 되돌리지 않으려면 **최신 행 위에** 병합해야 한다(352 의 재조회와 같은 이유).
    const fresh = (await getEntity<any>("clip", clipId)) ?? clip;
    const merged: any = { ...fresh };
    if (next) merged.autoRender = next; else delete merged.autoRender;
    await putEntity("clip", clipId, merged);
    Object.assign(clip, merged);
    if (!next) delete clip.autoRender;
  }

  // 확정은 **상태 전이에서만** 기록한다. hasRunNote 를 가드로 쓰면 worker.ts 의 배포 실패가
  // 같은 (규칙, 클립, 계정없음, failed) 키를 이미 점유해 렌더 실패가 한 줄도 안 남는다 —
  // 침묵 쪽으로 실패하는 가드는 이 벨트가 고치려는 병 그 자체다.
  if (next?.failed && !prev?.failed) {
    report.renderFailed += 1;
    await note({ ruleId, clipId, result: "failed", accountKey: null, detail: autoRenderFailedNote(next) });
  }
  return outcome.ok;
}

/**
 * AI 리프레임 요청 — 수동 채택 직후 프론트가 부르는 것과 **같은 라우트**
 * (POST /api/clips/:id/reframe · mode="ai_multi" · 내부 인증은 requestAutoRender 와 동일).
 * dedupe(입력 지문 CAS·requestId)·잡 페이로드·clip.reframe 상태 전이가 전부 라우트 안에
 * 있으므로 여기서 복제하지 않는다 — 두 벌이 되면 한쪽만 고쳐진다.
 *
 * 던지지 않는다: 실패하면 false — 호출부가 기본(중앙 크롭) 렌더로 진행한다(수동 경로의
 * "adopt→reframe 큐잉 실패" 콘솔 폴백과 같은 결말). 분석 실패(failed) 후 재시도는 수동과
 * 마찬가지로 사람 몫(retry=true)이다 — 자동 재시도 루프는 분석 원가만 태운다.
 */
async function requestAutoReframe(clipId: string): Promise<boolean> {
  try {
    const { apiBase, internalHeaders } = await import("./factory.ts");
    const res = await fetch(`${apiBase()}/api/clips/${clipId}/reframe`, {
      method: "POST",
      headers: { ...(await internalHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ mode: "ai_multi" }),
    });
    if (!res.ok) throw new Error(`reframe ${res.status}`);
    return true;
  } catch (e) {
    console.warn(`[automation] AI 리프레임 요청 실패 ${clipId}: ${String(e).slice(0, 160)}`);
    return false;
  }
}

/**
 * 채널별 업로드 메타데이터 즉석 생성 — 수동 발행 화면·clip.metadata 잡이 부르는 것과 **같은
 * 라우트**(POST /api/clips/:id/generate-metadata · 내부 인증은 requestAutoRender 와 동일).
 * 프롬프트·채널 규칙·저장이 전부 라우트 안에 있으므로 여기서 복제하지 않는다 — 두 벌이 되면
 * 화면에서 누른 것과 자동 생성이 갈라진다(clip.metadata 워커 핸들러와 같은 이유).
 *
 * 라우트는 **전 채널을 한 번에** 만들어 clip.channelMeta 에 저장한다. `channel` 인자는
 * 로그·호출 의도 표기용이다(한 클립에 실제 Gemini 호출은 채널 무관 1회). 호출부는 channelMeta 가
 * 없을 때만 부르므로 (클립당) 한 번만 돈다 — 매 순방·매 채널 재생성으로 원가를 태우지 않는다.
 *
 * 던지지 않는다: 실패하면 false — 호출부가 clip.metadata 잡 폴백으로 낮춘다(다음 순방 재시도).
 * requestAutoRender·requestAutoReframe 와 같은 계약이라 순방 전체를 막지 않는다.
 */
async function requestAutoMetadata(clipId: string, channel: string): Promise<boolean> {
  try {
    const { apiBase, internalHeaders } = await import("./factory.ts");
    const res = await fetch(`${apiBase()}/api/clips/${clipId}/generate-metadata`, {
      method: "POST", headers: await internalHeaders(),
    });
    if (!res.ok) throw new Error(`generate-metadata ${res.status}`);
    return true;
  } catch (e) {
    console.warn(`[automation] 메타데이터 생성 실패 ${clipId} (${channel}): ${String(e).slice(0, 160)}`);
    return false;
  }
}

/** 규칙이 이 클립을 만들었는지 — 화면·로그가 자동 생성물을 가려낼 때. */
export async function isAutomationClip(clipId: string): Promise<boolean> {
  const clip = await getEntity<any>("clip", clipId);
  return Boolean(clip?.automationRuleId);
}
