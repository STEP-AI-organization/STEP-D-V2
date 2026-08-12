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
  getEntity,
  holdClip,
  isHeldAwaitingHuman,
  listAutomationRules,
  listEntities,
  listMedia,
  getAutomationSetting,
  getChannelRule,
  publishedTodayKst,
} from "./db-pg.ts";
import {
  decidePublish, inActiveWindow, planCycle, ruleChannels, rulePrograms, selectCandidates,
  type AutomationRule,
} from "./automation.ts";
import { eligibility, type ChannelRule } from "./channel-rules.ts";
import { newId } from "./pipeline.ts";
import { clipGate, dispatchPublish } from "./publish-dispatch.ts";
import { basicReframeState } from "./reframe.ts";

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

      const cands = recommendations.filter((r) => r.episodeId === ep.id);
      const pickedIds = new Set(selectCandidates(rule, cands).map((r) => r.id));
      const picked = cands.filter((r) => pickedIds.has(r.id));

      for (const rec of picked) {
        const master = media.find((m: any) => m.episodeId === rec.episodeId && m.role === "master") as any;
        const clipId = newId("c");
        // 무인 렌더 시드 — factory 와 동일한 기본 모양 (규칙의 templateId·layout 최우선).
        const { autoEditorState } = await import("./factory.ts");
        const program = ep.programId ? await getEntity<any>("program", ep.programId) : undefined;
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
          aspectRatio: rec.kind === "short" ? "9:16-crop-main" : "16:9",
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
          editorState: autoEditorState(rec, ep.programTitle ?? "", program,
            (rule as any).templateId, (rule as any).layout),
        };

        const ok = await commitAndInherit(clipId, clip, rec.id, rec);
        if (!ok) continue; // 다른 요청이 먼저 채택했다
        report.adopted += 1;
        await appendRuleRun({ ruleId: rule.id, clipId, result: "media_created", detail: rec.title });
      }
    }

    // ── 04·05 — 채널마다 **하루 할당량이 찰 때까지** 게시한다 ──────────────────
    const epIds = new Set(eps.map((e) => e.id));
    const mine = (await listEntities<any>("clip")).filter(
      (c) => c.automationRuleId === rule.id && epIds.has(c.episodeId),
    );

    for (const chan of channels) {
      const accountKey = `${chan.platform}:${chan.accountId}`;
      const quota = Number(rule.dailyQuota) > 0 ? Number(rule.dailyQuota) : 3;
      let remaining = quota - (await publishedTodayKst(rule.id, accountKey));
      if (remaining <= 0) continue; // 오늘 할당량 완료 — 내일 KST 자정에 리셋

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
        const already = (clip.distributions ?? []).some((d: any) => {
          if (d.channel !== chan.platform || d.status === "failed") return false;
          const acct = d.youtubeChannelId ?? d.naverAccountId ?? null;
          return acct === null || acct === chan.accountId;
        });
        if (already) continue;

        const why = eligibility(channelRule, {
          id: clip.id, durationSec: clip.durationSec,
          aspectRatio: clip.aspectRatio, rendered: clip.rendered !== false,
        });
        if (!why.ok) {
          await appendRuleRun({ ruleId: rule.id, clipId: clip.id, result: "skipped", detail: why.reason, accountKey });
          continue;
        }

        const gate = await clipGate(clip.id);
        const held = await isHeldAwaitingHuman(rule.id, clip.id);
        const decision = decidePublish({
          rule,
          gate: { allowed: gate.allowed, state: gate.state, reason: gate.reason },
          // 승인 정책은 사람의 보류 해제를 승인으로 본다 — 별도 승인 버튼을 또 만들지 않는다.
          approved: !held,
          heldAwaitingHuman: held,
        });

        if (decision.action === "hold") {
          await holdClip(rule.id, clip.id, decision.reason);
          await appendRuleRun({ ruleId: rule.id, clipId: clip.id, result: "held", detail: decision.reason, accountKey });
          report.held += 1;
          continue;
        }
        if (decision.action === "skip") continue;

        // 05 게시 — 사람이 누르는 배포와 **같은 관문**을 지난다(F6 Invariant).
        // 네이버는 설명이 필수(클립 10자) — 자동 경로에서는 클립 시놉시스/제목으로 채운다.
        const isNaver = chan.platform === "navertv" || chan.platform === "naverclip";
        const desc = String(clip.synopsis ?? clip.title ?? "").trim();
        const outcome = await dispatchPublish({
          clipIds: [clip.id],
          channel: chan.platform,
          youtubeChannelId: chan.accountId,
          ...(isNaver ? {
            naverAccountId: chan.accountId,
            description: desc.length >= 10 ? desc : `${desc} 하이라이트 클립`.trim(),
            naverCategory: { primary: "엔터", secondary: "엔터" },
          } : {}),
          actor: `automation:${rule.id}`,
          origin: "factory",
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
            detail: outcome.notice,
            accountKey,
          });
        }
      }
    }
  }

  return report;
}

/** 규칙이 이 클립을 만들었는지 — 화면·로그가 자동 생성물을 가려낼 때. */
export async function isAutomationClip(clipId: string): Promise<boolean> {
  const clip = await getEntity<any>("clip", clipId);
  return Boolean(clip?.automationRuleId);
}
