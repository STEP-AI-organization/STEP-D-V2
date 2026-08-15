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
  listAutomationRules,
  listEntities,
  listMedia,
  putEntity,
  getAutomationSetting,
  getChannelRule,
  hasRunNote,
  publishedTodayKst,
} from "./db-pg.ts";
import {
  CREDIT_IDLE_REASON,
  decidePublish, inActiveWindow, overlapsExistingClip, planCycle, ruleChannels, rulePrograms,
  selectCandidates,
  type AutomationRule,
} from "./automation.ts";
import {
  youtubeUploadEnabled, tiktokUploadEnabled, instagramUploadEnabled, facebookUploadEnabled,
} from "./upload-gate.ts";
import { naverUploadEnabled } from "./naver-gate.ts";
import { eligibility, type ChannelRule } from "./channel-rules.ts";
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

export interface CycleReport {
  tenantScoped: true;
  rulesEvaluated: number;
  adopted: number;
  published: number;
  held: number;
  idleReason: string;
}

/** 현재 테넌트의 규칙을 한 바퀴 돈다. */
export async function runAutomationCycle(): Promise<CycleReport> {
  // 크레딧 게이트 — 잔액 0 이하면 채택도 게시도 하지 않는다. 채택은 렌더(원가),
  // 게시는 업로드로 이어져 잔액 없는 워크스페이스가 자동으로 원가를 계속 쓰게 된다.
  // 사유를 리포트에 실어 GET /api/automation 이 화면에 같은 문구를 보여준다.
  if ((await creditBalance()) <= 0) {
    return {
      tenantScoped: true, rulesEvaluated: 0, adopted: 0, published: 0, held: 0,
      idleReason: CREDIT_IDLE_REASON,
    };
  }

  const paused = (await getAutomationSetting("automation.paused")) === "true";
  const rules = (await listAutomationRules()) as unknown as AutomationRule[];
  const plan = planCycle({ paused, rules });

  const report: CycleReport = {
    tenantScoped: true,
    rulesEvaluated: plan.rules.length,
    adopted: 0,
    published: 0,
    held: 0,
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

  for (const rule of plan.rules) {
    // 활동 시간창(KST · 기본 9~22) 밖에서는 아무것도 하지 않는다 — 다음 순방에 다시 본다.
    if (!inActiveWindow(rule)) {
      if (!report.idleReason) report.idleReason =
        `활동 시간(${rule.activeStart ?? 9}~${rule.activeEnd ?? 22}시) 밖 — 대기 중`;
      continue;
    }

    const programs = rulePrograms(rule);
    const channels = ruleChannels(rule);

    // 01 회차 수신 — 이 규칙의 프로그램(들) 회차만.
    const eps = episodes.filter((e) => programs.includes(e.programId));
    if (eps.length === 0) continue;

    // ── 03 미디어 생성 — 프로그램 전체에서 규칙 조건을 통과한 추천을 채택한다 ──
    for (const ep of eps) {
      // 02 분석 — 끝나지 않았으면 다음 순방에 다시 본다.
      const stage = ep.pipeline?.stageStatus;
      if (stage === "idle" || stage === "progress") continue;

      // 이 회차의 기존 클립(수동 채택 포함)과 구간이 겹치는 추천은 제외 — 재분석이
      // 추천을 새 ID 로 다시 만들어도 이미 내보낸 구간이 재채택되지 않게(중복 배포 방지).
      const epClips = allClips.filter((c) => c.episodeId === ep.id);
      const cands = recommendations
        .filter((r) => r.episodeId === ep.id)
        .filter((r) => !overlapsExistingClip(r, epClips));
      // top3 는 회차당 상한 — 이 규칙이 이 회차에서 이미 채택한 수를 빼고 뽑는다.
      const pickedIds = new Set(
        selectCandidates(rule, cands, adoptedCountFor(rule.id, ep.id)).map((r) => r.id));
      const picked = cands.filter((r) => pickedIds.has(r.id));

      for (const rec of picked) {
        const master = media.find((m: any) => m.episodeId === rec.episodeId && m.role === "master") as any;
        const clipId = newId("c");
        // 무인 렌더 시드 — factory 와 동일한 기본 모양 (규칙의 templateId·layout 최우선).
        const { autoEditorState } = await import("./factory.ts");
        const program = ep.programId ? await getEntity<any>("program", ep.programId) : undefined;
        // 채택 형태 — 규칙의 방향 선택을 **수동 채택(adopt 라우트)과 같은 매핑**으로 클립에
        // 적용한다. 미지정이면 기존처럼 추천 kind 로 결정(하위호환 · 리프레임 OFF 시 불변).
        const aspectRatio = rule.orientation === "portrait" ? "9:16-crop-main"
          : rule.orientation === "landscape" ? "16:9"
          : (rec.kind === "short" ? "9:16-crop-main" : "16:9");
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
              (rule as any).templateId, (rule as any).layout),
            // autoEditorState 는 쇼츠 전제로 aspect 9:16 을 박는데, /export 는 editorState.aspect
            // 를 **최우선**으로 읽는다 — 가로 규칙은 여기서 안 뒤집으면 aspectRatio 에 저장만
            // 되고 렌더에 미도달(세로로 나간다). 미지정·세로는 기존값 그대로.
            ...(rule.orientation === "landscape" ? { aspect: "16:9" } : {}),
          },
        };

        const ok = await commitAndInherit(clipId, clip, rec.id, rec);
        if (!ok) continue; // 다른 요청이 먼저 채택했다
        report.adopted += 1;
        // 같은 순방 안에서 top3 상한이 정확히 걸리도록 로컬 목록에도 반영한다.
        allClips.push(clip);
        // "렌더 대기"를 사람 말로 남긴다 — 렌더가 늦거나 실패해도 실행 로그만 보면
        // 클립이 어디까지 왔는지 보이게. 조용한 스킵(not_rendered 무한 반복)의 해독제다.
        await appendRuleRun({
          ruleId: rule.id, clipId, result: "media_created",
          detail: `${rec.title} — 클립 생성 · 렌더 대기`,
        });
        // 채널별 메타데이터 생성 — 수동 채택(adopt 라우트)과 같은 배선. 안 걸면 자동
        // 클립은 clip.title 폴백으로만 나간다(프로그램 제목 프롬프트·태그 미반영).
        await enqueue("clip.metadata", { clipId }, { dedupeKey: `clip.metadata:${clipId}` }).catch(() => {});
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
          await requestAutoRender(clipId);
        }
      }
    }

    // ── 04·05 — 채널마다 **하루 할당량이 찰 때까지** 게시한다 ──────────────────
    const epIds = new Set(eps.map((e) => e.id));
    const mine = (await listEntities<any>("clip")).filter(
      (c) => c.automationRuleId === rule.id && epIds.has(c.episodeId),
    );

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
          await appendRuleRun({ ruleId: rule.id, result: "skipped", detail: upGate.offNote, accountKey });
        }
        continue;
      }

      const quota = Number(rule.dailyQuota) > 0 ? Number(rule.dailyQuota) : 3;
      let remaining = quota - (await publishedTodayKst(accountKey));
      if (remaining <= 0) {
        // 조용히 넘기면 "왜 오늘은 아무것도 안 나갔지" 를 설명할 근거가 로그에 없다.
        // 채널당 하루 한 줄만 남긴다(순방은 10분마다 돈다).
        if (!(await hasRunNote(rule.id, null, accountKey, "skipped", true))) {
          await appendRuleRun({
            ruleId: rule.id, clipId: null, result: "skipped", accountKey,
            detail: `오늘 이 채널 할당량(${quota}건)을 다 썼습니다 — 내일 자정(KST)에 초기화됩니다.`,
          });
        }
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
          if (vague && !(await hasRunNote(rule.id, clip.id, accountKey))) {
            await appendRuleRun({
              ruleId: rule.id, clipId: clip.id, result: "skipped", accountKey,
              detail: "계정 미상 배포 기록이 있어 건너뜁니다 — 이미 나간 건이면 그대로 두고, 아니면 배포 화면에서 계정을 지정해 발행하세요.",
            });
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
          if (!(await hasRunNote(rule.id, clip.id, accountKey, "failed"))) {
            await appendRuleRun({
              ruleId: rule.id, clipId: clip.id, result: "failed", accountKey,
              detail: "직전 배포가 실패했습니다 — 자동 재시도는 하지 않습니다. 배포 기록에서 재시도를 눌러 주세요.",
            });
          }
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
              await appendRuleRun({
                ruleId: rule.id, clipId: clip.id, result: "skipped",
                detail: "AI 리프레임 결과가 낡아 다시 분석을 겁니다 — 끝나면 자동으로 게시됩니다.", accountKey,
              });
            } else if (rf.status === "failed" || stuckMs > REFRAME_STUCK_MS) {
              await putEntity("clip", clip.id, { ...clip, reframe: basicReframeState() });
              clip.reframe = basicReframeState();
              await appendRuleRun({
                ruleId: rule.id, clipId: clip.id, result: "skipped",
                detail: rf.status === "failed"
                  ? "AI 리프레임 분석 실패 — 기본(중앙 크롭)으로 렌더를 진행합니다."
                  : `AI 리프레임이 ${Math.round(stuckMs / 60000)}분째 진행이 없어 기본(중앙 크롭)으로 렌더합니다.`,
                accountKey,
              });
            }
          }
          if (await requestAutoRender(clip.id)) {
            const fresh = await getEntity<any>("clip", clip.id);
            if (fresh) Object.assign(clip, fresh);
          }
        }

        const why = eligibility(channelRule, {
          id: clip.id, durationSec: clip.durationSec,
          aspectRatio: clip.aspectRatio, rendered: clip.rendered !== false,
        });
        if (!why.ok) {
          // not_rendered 의 기본 문구는 수동 화면용("내보내기 후…")이라 자동 경로에선
          // 오독된다 — 사람이 할 일이 없음을 말해 준다.
          const detail = why.code === "not_rendered"
            ? "렌더 대기 — 완료되면 다음 순방에 자동으로 게시됩니다."
            : why.reason;
          await appendRuleRun({ ruleId: rule.id, clipId: clip.id, result: "skipped", detail, accountKey });
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
          await holdClip(rule.id, clip.id, decision.reason);
          await appendRuleRun({ ruleId: rule.id, clipId: clip.id, result: "held", detail: decision.reason, accountKey });
          report.held += 1;
          continue;
        }
        if (decision.action === "skip") continue;

        // 채널별 메타 없이 게시하지 않는다 — 워커 metaForChannel 폴백(clip.title)으로
        // 나가면 제목 프롬프트·채널별 태그가 미반영된 채 실업로드된다. 생성 잡을
        // (재)큐잉하고 이번 순방은 넘긴다 — dedupe 는 pending/running 에만 걸리므로
        // 잡이 실패했어도 다음 순방이 다시 큐잉한다(조용한 영구 정지 없음).
        const chanMeta = (clip as any).channelMeta?.[chan.platform];
        if (!chanMeta || !(chanMeta.title || chanMeta.description)) {
          await enqueue("clip.metadata", { clipId: clip.id }, { dedupeKey: `clip.metadata:${clip.id}` }).catch(() => {});
          await appendRuleRun({
            ruleId: rule.id, clipId: clip.id, result: "skipped",
            detail: "메타데이터 생성 대기 — 완료되면 다음 확인 때 자동으로 게시됩니다.", accountKey,
          });
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
          ...(chan.platform === "youtube"
            ? { privacy: (["public", "unlisted", "private"] as const)
                .includes((channelRule as any)?.privacy) ? (channelRule as any).privacy : "unlisted" }
            : {}),
          actor: `automation:${rule.id}`,
          // "factory"(외부 공장 API)와 구분되는 자동 순방 표식 — 화면의 자동/수동 배지가 읽는다.
          origin: "automation",
        });

        if (outcome.skipped.length > 0) {
          const reason = outcome.skipped[0].reason;
          await holdClip(rule.id, clip.id, reason);
          await appendRuleRun({ ruleId: rule.id, clipId: clip.id, result: "held", detail: reason, accountKey });
          report.held += 1;
        } else {
          const published = outcome.queued.length > 0;
          if (published) remaining -= 1;
          report.published += published ? 1 : 0;
          await appendRuleRun({
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
  }

  return report;
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
  const blocked = (env: string) => ({
    send: false, recordOnly: false,
    offNote: `실제 업로드가 꺼져 있습니다 (${env} 미설정) — 보내지 않음. 게이트를 켜면 다음 순방에 게시됩니다.`,
  });
  const recordOnly = (env: string) => ({
    send: true, recordOnly: true,
    offNote: `실제 업로드 꺼짐 (${env} 미설정) — 기록만 됨`,
  });
  switch (platform) {
    case "youtube": return youtubeUploadEnabled() ? on : blocked("YOUTUBE_UPLOAD_ENABLED");
    case "navertv":
    case "naverclip": return naverUploadEnabled() ? on : blocked("NAVER_UPLOAD_ENABLED");
    case "tiktok": return tiktokUploadEnabled() ? on : recordOnly("TIKTOK_UPLOAD_ENABLED");
    case "instagram": return instagramUploadEnabled() ? on : recordOnly("INSTAGRAM_UPLOAD_ENABLED");
    case "facebook": return facebookUploadEnabled() ? on : recordOnly("FACEBOOK_UPLOAD_ENABLED");
    default: return on;
  }
}

/**
 * 렌더 요청 — factory 의 requestExport 와 같은 경로(POST /api/clips/:id/export · 내부 인증).
 * 렌더 로직이 서버 라우트에 있는 이유(자막·훅 프리롤·썸네일 오버레이가 전부 거기)는
 * factory.ts 렌더 단계 주석과 같다 — 워커에서 복제하면 두 벌이 갈라진다.
 *
 * 던지지 않는다: 실패한 렌더는 다음 순방의 not_rendered 분기가 다시 요청한다.
 * 중복 렌더 방지(dedupe)는 두 겹 — (1) 순방 잡 자체가 automation.cycle:{tenantId}
 * dedupeKey 로 테넌트당 직렬이고, (2) /export 는 revision 캐시가 있어 이미 렌더된
 * 클립의 재요청은 재인코딩 없이 즉시 돌아온다.
 */
async function requestAutoRender(clipId: string): Promise<boolean> {
  try {
    const { apiBase, internalHeaders } = await import("./factory.ts");
    const res = await fetch(`${apiBase()}/api/clips/${clipId}/export`, {
      method: "POST", headers: await internalHeaders(),
    });
    if (!res.ok) throw new Error(`export ${res.status}`);
    return true;
  } catch (e) {
    console.warn(`[automation] 렌더 요청 실패 ${clipId}: ${String(e).slice(0, 160)}`);
    return false;
  }
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

/** 규칙이 이 클립을 만들었는지 — 화면·로그가 자동 생성물을 가려낼 때. */
export async function isAutomationClip(clipId: string): Promise<boolean> {
  const clip = await getEntity<any>("clip", clipId);
  return Boolean(clip?.automationRuleId);
}
