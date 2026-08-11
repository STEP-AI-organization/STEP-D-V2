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
 *
 * ⚠️ 현재 실제 소비자는 `programSmrChecks` 하나뿐이다
 * (programs/[id]/settings/page.tsx — 미충족 개수 표시). 구형 publish-dialog 가 사라지면서
 * 아래 채널별 판정 블록(smrChecks·youtubeChecks·socialStubChecks·CHANNEL_EVAL·evaluateChannel
 * 과 hasThumbnail/isVertical/isEncoded)은 호출자가 0 이다.
 *
 * 존치 사유: 배포 가능 여부의 최종 판정은 서버(/api/channel-rules/eligibility + 업로드 게이트)가
 * 하지만, 서버는 "무엇이 왜 빠졌는지"를 채널별 체크리스트로 돌려주지 않는다. 클라 체크리스트를
 * 다시 붙일 때 재사용할 명세로 남긴다. 새로 판정 UI 를 붙일 때는 서버 응답을 우선하고 이 모듈은
 * 보조 설명용으로만 쓸 것 — 두 판정이 갈리면 서버가 맞다.
 */

import {
  CLIP_TYPES,
  TARGET_AGES,
  type DistributionChannel,
} from "@/lib/constants";
import { WEEKDAYS } from "@/lib/reserve-date";
import type {
  Clip,
  Connections,
  Episode,
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
  // 목록(/programs)이 아니라 실제 입력이 있는 화면으로 보낸다.
  // (현재 이 fix 링크를 렌더하는 소비자는 없다 — settings 화면은 미충족 개수만 센다.)
  const fix = { label: "프로그램 설정", href: program ? `/programs/${program.id}/settings` : "/programs" };
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
      // smr.posterReady 는 세터가 어디에도 없어 영구 false 였다 — 실제로 저장되는 필드로 판정한다.
      label: "포스터 이미지",
      met: Boolean(program?.posterImageDataUrl),
      detail: program?.posterImageDataUrl ? "등록됨" : "미등록",
      scope: "program",
      fix,
    },
    // "프로그램 썸네일" 체크는 제거했다 — 저장 필드도 등록 UI도 없어 충족 자체가 불가능했다.
  ];
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

/** 소셜 채널(Instagram · Facebook · TikTok) 공용 체크 팩토리. 백엔드 미배선 상태라
 *  실제 발행은 안 되고 UI에서 "준비 중" 배지·계정 미연결 안내만 뜬다.
 *  vertical=true면 세로 비율(9:16*) 필수(IG Reels · TikTok). Facebook은 세로가 권장이지만
 *  가로도 허용해서 vertical=false. */
function socialStubChecks(
  keyPrefix: string,
  label: string,
  connected: boolean,
  vertical: boolean,
): (ctx: EvalContext) => RequirementCheck[] {
  return (ctx) => {
    const { clip } = ctx;
    const checks: RequirementCheck[] = [
      {
        key: `${keyPrefix}-account`,
        label: "계정 연결",
        met: connected,
        detail: connected ? "연결됨" : `${label} 연결 준비 중(백엔드 미배선)`,
        scope: "account",
        fix: { label: "계정 연결", href: "/publish-channels" },
      },
      {
        key: `${keyPrefix}-file`,
        label: "인코딩 완료",
        met: isEncoded(clip),
        detail: isEncoded(clip) ? "완료" : "편집·인코딩 필요",
        scope: "clip",
      },
    ];
    if (vertical) {
      checks.push({
        key: `${keyPrefix}-vertical`,
        label: "세로 영상",
        met: isVertical(clip.aspectRatio),
        detail: isVertical(clip.aspectRatio) ? "세로 비율" : `가로(${clip.aspectRatio}) — ${label}는 세로 필수`,
        scope: "clip",
      });
    }
    return checks;
  };
}

const EVALUATORS: Record<DistributionChannel, (ctx: EvalContext) => RequirementCheck[]> = {
  smr: smrChecks,
  youtube: youtubeChecks,
  instagram: (ctx) => socialStubChecks("ig", "Instagram", ctx.connections.instagram, true)(ctx),
  facebook: (ctx) => socialStubChecks("fb", "Facebook", ctx.connections.facebook, false)(ctx),
  tiktok: (ctx) => socialStubChecks("tt", "TikTok", ctx.connections.tiktok, true)(ctx),
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

// evaluateChannels·structuralBlockers·isStructurallyReady·readinessTone 은 호출자가 하나도
// 없어 삭제했다(2026-08-11). 필요해지면 evaluateChannel 위에서 다시 조립하면 된다.
// (evaluateChannel 이하도 지금은 호출자 0 이다 — 삭제하지 않고 남긴 이유는 파일 상단 주석 참고.)
