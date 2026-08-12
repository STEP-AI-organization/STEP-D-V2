/**
 * Channel publish-readiness engine (docs/plans/publish-fields-ux-plan.md §5.2).
 *
 * Each distribution channel has its OWN required fields; a clip can be ready for
 * one channel and not another. This module computes, per channel, a checklist of
 * requirements with met/unmet state — so the UI can gate publishing independently
 * and surface exactly what's missing (no silent drop).
 *
 * Field sources mirror STEPD:
 *  - 네이버 TV/클립은 브라우저 자동화로 올린다 → 계정 세션 + 발행 시점 입력(설명·카테고리).
 *  - YouTube/Meta are per-item pushes → account connection + a few per-publish fields.
 *
 * ⚠️ 현재 이 모듈의 호출자는 0 이다(구형 publish-dialog 가 사라지면서 끊겼다).
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
import type {
  Clip,
  Connections,
  Episode,
  Program,
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
  /** 예약 공개일시(reserve 문자열). 비면 미설정. */
  reserveDate?: string;
  scheduled?: boolean;
  /** 발행 시점에 사람이 넣는 설명. 네이버 클립은 10자 이상이어야 등록 자체가 된다. */
  description?: string;
}

export interface EvalContext {
  clip: Clip;
  episode?: Episode;
  program?: Program;
  connections: Connections;
  inputs: PublishInputs;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A clip has a usable thumbnail (YouTube cover 등). */
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

// ── per-channel evaluation ─────────────────────────────────────────────────────

/**
 * 네이버 TV·클립.
 *
 * 예전에는 여기에 포털 피드 판정이 있었다 — 프로그램 코드·편성요일·카테고리를 프로그램마다
 * 입력받는 폼이 붙어 있었는데, **그 값을 읽는 소비처가 어디에도 없었다.** 실제 네이버 발행은
 * 브라우저 자동화(naver.publish)로 하고, 거기서 막히는 건 전혀 다른 것들이다. 그래서
 * 판정을 실제 실패 지점으로 바꿨다.
 *
 * ⚠️ 최종 판정은 서버다(/api/distributions/publish 가 계정·설명·카테고리를 다시 본다).
 * 여기 체크리스트는 "무엇이 왜 빠졌는지"를 미리 보여주는 설명용이다 — 둘이 갈리면 서버가 맞다.
 */
function naverChecks(target: "tv" | "clip") {
  return (ctx: EvalContext): RequirementCheck[] => {
    const { clip, connections, inputs } = ctx;
    const desc = inputs.description?.trim() ?? "";
    const checks: RequirementCheck[] = [
      {
        key: "naver-file",
        label: "확정(렌더) 완료",
        met: isEncoded(clip),
        detail: isEncoded(clip) ? "완료" : "에디터에서 확정(렌더) 필요",
        scope: "clip",
      },
      {
        key: "naver-account",
        label: "네이버 계정 연결",
        met: Boolean(connections.naver),
        detail: connections.naver ? "연결됨" : "배포채널 화면에서 계정 추가 후 로그인",
        scope: "account",
        fix: { label: "배포채널", href: "/publish-channels" },
      },
    ];
    if (target === "clip") {
      // 실측(2026-08-11): 설명이 10자 미만이면 등록 버튼 자체가 비활성이다.
      checks.push({
        key: "naver-description",
        label: "설명 10자 이상",
        met: desc.length >= 10,
        detail: desc ? `${desc.length}자` : "미입력",
        scope: "publish",
      });
      checks.push({
        key: "naver-vertical",
        label: "세로 9:16",
        met: isVertical(clip.aspectRatio),
        detail: isVertical(clip.aspectRatio) ? clip.aspectRatio : `현재 ${clip.aspectRatio} — 클립은 세로만 받는다`,
        scope: "clip",
      });
    }
    return checks;
  };
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
  navertv: naverChecks("tv"),
  naverclip: naverChecks("clip"),
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
