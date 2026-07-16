/**
 * Channel publish-readiness engine (docs/plans/publish-fields-ux-plan.md §5.2).
 *
 * Each distribution channel has its OWN required fields; a clip can be ready for
 * one channel and not another. This module computes, per channel, a checklist of
 * requirements with met/unmet state — so the UI can gate publishing independently
 * and surface exactly what's missing (no silent SMR drop).
 *
 * Field sources mirror STEPD:
 *  - SMR is rendered from clip/episode/program columns → those must be complete,
 *    plus program-level feed metadata (set once per program).
 *  - YouTube/Meta are per-item pushes → account connection + a few per-publish fields.
 */

import {
  CLIP_TYPES,
  TARGET_AGES,
  type DistributionChannel,
  type StatusTone,
} from "@/lib/constants";
import { WEEKDAYS } from "@/lib/reserve-date";
import type {
  Clip,
  Connections,
  Episode,
  MetaPlatform,
  Program,
  ProgramSmrConfig,
} from "@/lib/types";

/** Where a requirement is fixed — drives grouping and deep-link affordances. */
export type CheckScope = "common" | "clip" | "episode" | "program" | "account" | "publish";

export interface RequirementCheck {
  key: string;
  label: string;
  met: boolean;
  /** Short explanation of the current value / what's missing. */
  detail?: string;
  scope: CheckScope;
  /** Optional checks don't block publish (e.g. AI-drafted caption). */
  optional?: boolean;
  /** Where to resolve it, when not a publish-time input. */
  fix?: { label: string; href?: string };
}

export interface ChannelReadiness {
  channel: DistributionChannel;
  ready: boolean;
  checks: RequirementCheck[];
  /** Unmet, non-optional checks (what blocks publishing). */
  missing: RequirementCheck[];
}

/** Operator inputs collected in the publish surface (per channel). */
export interface PublishInputs {
  /** SMR / scheduled public datetime (reserve string). Empty ⇒ not set. */
  reserveDate?: string;
  scheduled?: boolean;
  /** Meta target surfaces. */
  platforms?: MetaPlatform[];
}

export interface EvalContext {
  clip: Clip;
  episode?: Episode;
  program?: Program;
  connections: Connections;
  inputs: PublishInputs;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A clip has a usable thumbnail (SMR contentImg / YouTube cover). */
export function hasThumbnail(clip: Clip): boolean {
  return Boolean(clip.thumbnailUrl || clip.thumbnailLabel);
}

/** Vertical clips (9:16*) satisfy IG Reels' portrait requirement. */
export function isVertical(aspectRatio: string): boolean {
  return aspectRatio.startsWith("9:16");
}

/** The clip has been encoded (has a deliverable file). */
export function isEncoded(clip: Clip): boolean {
  // "Rendered" = has an encoded deliverable (plan §2.4). A draft/mid-encode clip isn't
  // shippable — only the single export render produces a distributable file.
  return clip.rendered === true || Boolean(clip.mediaId) || clip.status === "ready" || clip.status === "published";
}

function weekdaysLabel(weekdays?: number[]): string {
  if (!weekdays || weekdays.length === 0) return "미설정";
  return weekdays.map((d) => WEEKDAYS[d]).join("·");
}

// ── program-level SMR readiness (set once per program) ─────────────────────────

/** SMR feed requirements that live on the PROGRAM, not the clip (plan §5.1③). */
export function programSmrChecks(program?: Program): RequirementCheck[] {
  const smr: ProgramSmrConfig = program?.smr ?? {};
  const fix = { label: "프로그램 설정", href: "/programs" };
  const codeOk = Boolean(smr.programCode && /^[a-z0-9]+$/.test(smr.programCode));
  return [
    {
      key: "smr-program-code",
      label: "프로그램 코드",
      met: codeOk,
      detail: smr.programCode
        ? codeOk
          ? smr.programCode
          : `형식 오류(${smr.programCode}) · 영문 소문자·숫자만`
        : "미입력",
      scope: "program",
      fix,
    },
    {
      key: "smr-program-category",
      label: "카테고리",
      met: Boolean(smr.category),
      detail: smr.category ?? "미설정",
      scope: "program",
      fix,
    },
    {
      key: "smr-program-weekcode",
      label: "편성 요일",
      met: Boolean(smr.weekdays && smr.weekdays.length > 0),
      detail: weekdaysLabel(smr.weekdays),
      scope: "program",
      fix,
    },
    {
      key: "smr-program-poster",
      label: "포스터 이미지",
      met: Boolean(smr.posterReady),
      detail: smr.posterReady ? "등록됨" : "미등록",
      scope: "program",
      fix,
    },
    {
      key: "smr-program-thumb",
      label: "프로그램 썸네일",
      met: Boolean(smr.thumbnailReady),
      detail: smr.thumbnailReady ? "등록됨" : "미등록",
      scope: "program",
      fix,
    },
  ];
}

/** True when every program-level SMR requirement is met. */
export function isProgramSmrReady(program?: Program): boolean {
  return programSmrChecks(program).every((c) => c.met);
}

// ── per-channel evaluation ─────────────────────────────────────────────────────

function smrChecks(ctx: EvalContext): RequirementCheck[] {
  const { clip, episode, program, inputs } = ctx;
  const ageOk = episode ? (TARGET_AGES as readonly number[]).includes(episode.targetAge) : false;
  return [
    {
      key: "smr-file",
      label: "확정(렌더) 완료",
      met: isEncoded(clip),
      detail: isEncoded(clip) ? "완료" : "에디터에서 확정(렌더) 필요",
      scope: "clip",
    },
    {
      key: "smr-cliptype",
      label: "클립 유형",
      met: clip.clipType in CLIP_TYPES,
      detail: clip.clipType in CLIP_TYPES ? CLIP_TYPES[clip.clipType] : "유형 오류",
      scope: "clip",
    },
    {
      key: "smr-thumb",
      label: "클립 썸네일",
      met: hasThumbnail(clip),
      detail: hasThumbnail(clip) ? (clip.thumbnailLabel ?? "등록됨") : "미등록",
      scope: "clip",
    },
    {
      key: "smr-link",
      label: "프로그램·회차 연결",
      met: Boolean(program && episode),
      detail: program && episode ? `${program.title} · ${episode.episodeNumber}화` : "연결 필요",
      scope: "clip",
    },
    {
      key: "smr-broaddate",
      label: "방송일자",
      met: Boolean(episode?.broadDate),
      detail: episode?.broadDate ?? "미입력",
      scope: "episode",
    },
    {
      key: "smr-age",
      label: "시청연령",
      met: ageOk,
      detail: episode ? `${episode.targetAge === 0 ? "전체" : episode.targetAge + "세"}` : "미설정",
      scope: "episode",
    },
    ...programSmrChecks(program),
    {
      key: "smr-reserve",
      label: "공개일시(예약)",
      met: Boolean(inputs.reserveDate),
      detail: inputs.reserveDate ? undefined : "SMR은 공개일시 필수 — 비면 네이버 미게시",
      scope: "publish",
    },
  ];
}

function youtubeChecks(ctx: EvalContext): RequirementCheck[] {
  const { clip, connections } = ctx;
  return [
    {
      key: "yt-account",
      label: "채널 연결",
      met: connections.youtube,
      detail: connections.youtube ? "연결됨" : "YouTube 채널 미연결",
      scope: "account",
      fix: { label: "채널 연결", href: "/publish-channels" },
    },
    {
      key: "yt-file",
      label: "인코딩 완료",
      met: isEncoded(clip),
      detail: isEncoded(clip) ? "완료" : "편집·인코딩 필요",
      scope: "clip",
    },
    {
      key: "yt-title",
      label: "제목",
      met: Boolean(clip.title?.trim()),
      detail: clip.title,
      scope: "common",
    },
  ];
}

function metaChecks(ctx: EvalContext): RequirementCheck[] {
  const { clip, connections, inputs } = ctx;
  const platforms = inputs.platforms ?? [];
  const igSelected = platforms.includes("instagram");
  return [
    {
      key: "meta-account",
      label: "계정 연결",
      met: connections.meta,
      detail: connections.meta ? "연결됨" : "Meta 페이지 미연결",
      scope: "account",
      fix: { label: "계정 연결", href: "/publish-channels" },
    },
    {
      key: "meta-platforms",
      label: "배포 플랫폼",
      met: platforms.length > 0,
      detail: platforms.length > 0 ? platforms.map(platformLabel).join(", ") : "IG/FB 중 최소 1개",
      scope: "publish",
    },
    {
      key: "meta-ig-link",
      label: "인스타그램 연결",
      met: !igSelected || connections.metaInstagram,
      detail: !igSelected
        ? "IG 미선택"
        : connections.metaInstagram
          ? "연결됨"
          : "IG 비즈니스 계정 연결 필요",
      scope: "account",
      fix: { label: "계정 연결", href: "/publish-channels" },
    },
    {
      key: "meta-vertical",
      label: "세로 영상(IG)",
      met: !igSelected || isVertical(clip.aspectRatio),
      detail: !igSelected
        ? "IG 미선택"
        : isVertical(clip.aspectRatio)
          ? "세로 비율"
          : `가로(${clip.aspectRatio}) — IG Reels 불가`,
      scope: "clip",
    },
    {
      key: "meta-file",
      label: "인코딩 완료",
      met: isEncoded(clip),
      detail: isEncoded(clip) ? "완료" : "편집·인코딩 필요",
      scope: "clip",
    },
  ];
}

const EVALUATORS: Record<DistributionChannel, (ctx: EvalContext) => RequirementCheck[]> = {
  smr: smrChecks,
  youtube: youtubeChecks,
  meta: metaChecks,
};

/** Evaluate one channel's readiness for a clip. */
export function evaluateChannel(
  channel: DistributionChannel,
  ctx: EvalContext,
): ChannelReadiness {
  const checks = EVALUATORS[channel](ctx);
  const missing = checks.filter((c) => !c.met && !c.optional);
  return { channel, ready: missing.length === 0, checks, missing };
}

/** Evaluate all channels for a clip. */
export function evaluateChannels(
  ctx: EvalContext,
): Record<DistributionChannel, ChannelReadiness> {
  return {
    smr: evaluateChannel("smr", ctx),
    youtube: evaluateChannel("youtube", ctx),
    meta: evaluateChannel("meta", ctx),
  };
}

/**
 * Blockers a publish-time input CAN'T fix (excludes scope 'publish' like
 * reserveDate / platform selection). Drives at-a-glance matrix hints: "structurally
 * publishable now, just open the dialog" vs "needs setup first".
 */
export function structuralBlockers(
  channel: DistributionChannel,
  ctx: EvalContext,
): RequirementCheck[] {
  return evaluateChannel(channel, ctx).checks.filter(
    (c) => !c.met && !c.optional && c.scope !== "publish",
  );
}

export function isStructurallyReady(channel: DistributionChannel, ctx: EvalContext): boolean {
  return structuralBlockers(channel, ctx).length === 0;
}

// ── labels ─────────────────────────────────────────────────────────────────────

export function platformLabel(p: MetaPlatform): string {
  return p === "instagram" ? "Instagram" : "Facebook";
}

/** Tone for a channel's readiness summary. */
export function readinessTone(r: ChannelReadiness): StatusTone {
  return r.ready ? "done" : "warn";
}
