/**
 * **렌더 계획** — 서버의 결정을 편집자 PC 로 옮기는 그릇.
 *
 * ## 왜 이 파일이 있나
 *
 * 로컬 렌더의 약속은 "편집자 PC 가 구운 것과 서버가 구운 것이 같다" 이다. 그 약속은
 * 대부분 **구조적으로** 지켜진다 — 무엇을 구울지 정하는 곳(`index.ts` export 라우트)도,
 * 어떻게 구울지 아는 곳(`ffmpeg.ts` `renderShort`)도 한 벌뿐이고 양쪽이 그걸 같이 쓴다.
 *
 * 딱 한 축만 구조로 안 지켜진다: **로컬 경로**. 서버의 `/tmp/ass-xxx.ass` 는 편집자 PC 에
 * 없다. 그래서 그 값만 JSON 으로 실어 보내고(`RenderPlan`), 받는 쪽이 자기 자리에 되살린
 * 뒤 다시 `RenderShortOpts` 로 조립한다(`planToRenderOpts`).
 *
 * 그 조립을 여기 **순수 함수 하나로** 둔 이유: 네이티브에 같은 코드를 또 쓰면 두 벌이
 * 되고, 두 벌이 되는 순간 약속이 깨진다. 그리고 순수 함수라 **왕복이 무손실인지 서버에서
 * 테스트로 증명할 수 있다** — 네트워크도 ffmpeg 도 없이(`render-plan-roundtrip.test.ts`).
 *
 * ⚠️ 이 파일은 **node 내장조차 import 하지 않는다.** 네이티브가 번들해 가져가므로
 *    의존이 붙으면 그쪽 빌드가 깨진다(`ffmpeg.ts` 와 같은 제약 · 테스트가 강제한다).
 */
import type { RenderShortOpts } from "./ffmpeg.js";

/** 계획이 URL 로 실어 보내는 자산의 이름. 받는 쪽은 이 이름으로 파일을 만든다. */
export type PlanAssetKey = "overlayPng" | "framePng" | "badgePng" | "hookTts";

/** 계획이 본문 그대로 싣는 자산의 이름 — 전부 ASS 자막(텍스트라 작다). */
export type PlanTextKey = "ass" | "captionAss" | "decorationAss" | "hookCaptionAss";

/**
 * 서버 → 편집자 PC 로 건너가는 것 전부.
 *
 * `render` 는 `RenderShortOpts` 에서 **경로만 뺀 나머지**다. 값을 여기서 새로 해석하지
 * 않는다 — 해석하면 그게 곧 두 번째 결정이 된다.
 */
export type RenderPlan = {
  clipId: string;
  /** 렌더 리비전 해시. 같은 값이면 같은 결과여야 한다 — 캐시·검증의 기준. */
  revision: string;
  clipMediaId: string;
  /** 결과 mp4 를 올릴 자리. */
  output: { objectPath: string };
  /**
   * 어느 원본인가. **바이트는 안 보낸다** — 편집자 PC 작업 공간에 이미 있고,
   * 안 옮기는 것이 로컬 렌더의 목적이다. 여기 값들은 "그 파일이 맞나" 를 확인하는 근거다.
   */
  source: {
    mediaId: string;
    filename: string | null;
    size: number | null;
    durationSec: number | null;
  };
  render: Omit<
    RenderShortOpts,
    "inputPath" | "outputPath" | "assPath" | "captionAssPath" | "decorationAssPath"
    | "overlayPngPath" | "frame" | "hookPreroll" | "badge"
  > & {
    frame: (Omit<NonNullable<RenderShortOpts["frame"]>, "overlayPath">) | null;
    hookPreroll:
      | (Omit<NonNullable<RenderShortOpts["hookPreroll"]>, "ttsPath" | "captionAssPath">)
      | null;
    badge: (Omit<NonNullable<RenderShortOpts["badge"]>, "path">) | null;
  };
  assets: Record<PlanTextKey, string | null> & Record<`${PlanAssetKey}Url`, string | null>;
};

/** 받는 쪽이 자기 디스크에 되살려 둔 실제 경로들. 없으면 그 자산은 없는 것이다. */
export type MaterializedAssets = Partial<Record<PlanTextKey | PlanAssetKey, string | null>>;

/**
 * 계획 + 되살린 로컬 경로 → **서버가 쓰는 것과 똑같은 `RenderShortOpts`**.
 *
 * 여기서 하는 일은 **경로를 끼우는 것뿐이다.** 값을 보정하거나 기본값을 채우지 않는다 —
 * 그런 판단을 여기 넣으면 서버가 안 한 판단을 편집자 PC 만 하게 되고, 그게 결과 차이가 된다.
 */
export function planToRenderOpts(
  plan: RenderPlan,
  paths: { inputPath: string; outputPath: string } & MaterializedAssets,
): RenderShortOpts {
  const r = plan.render;
  const at = (k: PlanTextKey | PlanAssetKey) => paths[k] ?? null;

  return {
    ...r,
    inputPath: paths.inputPath,
    outputPath: paths.outputPath,
    assPath: at("ass"),
    captionAssPath: at("captionAss"),
    decorationAssPath: at("decorationAss"),
    overlayPngPath: at("overlayPng"),
    // 프레임은 **그림이 있어야 성립한다.** PNG 를 못 받았는데 기하만 남기면 ffmpeg 가
    // 없는 파일을 열려다 죽는다 — 통째로 없는 것으로 떨어뜨린다.
    frame: r.frame && at("framePng") ? { ...r.frame, overlayPath: at("framePng")! } : null,
    badge: r.badge && at("badgePng") ? { ...r.badge, path: at("badgePng")! } : null,
    hookPreroll: r.hookPreroll
      ? { ...r.hookPreroll, ttsPath: at("hookTts"), captionAssPath: at("hookCaptionAss") }
      : null,
  };
}

/**
 * 계획을 굽기 전에 **받는 쪽이 확인해야 하는 것**.
 *
 * 자산을 하나라도 못 받았으면 굽지 않는다. 굽는 건 성공하지만 **오버레이나 자막만 빠진
 * 영상**이 나오고, 그게 그대로 배포되기 때문이다 — 아무도 에러를 못 본다. 그럴 바엔
 * 서버 렌더로 떨어지는 게 맞다.
 */
export function missingAssets(plan: RenderPlan, have: MaterializedAssets): string[] {
  const missing: string[] = [];
  const texts: PlanTextKey[] = ["ass", "captionAss", "decorationAss", "hookCaptionAss"];
  const files: PlanAssetKey[] = ["overlayPng", "framePng", "badgePng", "hookTts"];
  for (const k of texts) if (plan.assets[k] != null && !have[k]) missing.push(k);
  for (const k of files) if (plan.assets[`${k}Url`] != null && !have[k]) missing.push(k);
  return missing;
}
