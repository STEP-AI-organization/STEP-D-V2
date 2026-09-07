/**
 * **편집자 PC 에서 굽는다.** 서버가 정한 그대로.
 *
 * ## 왜 여기 렌더 로직이 없나
 *
 * 없는 게 이 파일의 요점이다. 어떻게 굽는지 아는 코드는 `apps/server/src/media/ffmpeg.ts`
 * 한 벌뿐이고, 이 파일은 그걸 **그대로 import 해서 부른다.** 복제하면 그날부터 서버가 구운
 * 영상과 편집자 PC 가 구운 영상이 갈라지기 시작하는데, 갈라져도 아무도 에러를 못 본다 —
 * ffmpeg 는 성공하고 배포도 되고 **결과물만 다르다.**
 *
 * 그게 가능한 이유: `ffmpeg.ts` 는 `node:child_process` 와 `node:fs` 만 import 한다(DB 도
 * GCS 도 Hono 도 안 건드린다). 그 조건은 서버 쪽 테스트가 지킨다
 * (`ffmpeg-binary-injectable.test.ts`) — 거기 의존이 하나 붙으면 이 import 가 깨지고,
 * 그때 고쳐야 할 것은 이 파일이 아니라 `ffmpeg.ts` 다.
 *
 * ## 이 파일이 실제로 하는 일
 *
 *   1. 계획이 URL 로 준 자산을 내려받고, 본문으로 준 자막을 파일로 쓴다
 *   2. 원본을 **작업 공간에서 찾는다** (내려받지 않는다 — 안 옮기는 게 로컬 렌더의 목적)
 *   3. 하나라도 빠졌으면 **굽지 않고 사유를 돌려준다** → 호출부가 서버 렌더로 떨어뜨린다
 *   4. 서버와 같은 `renderShort` 를 부른다
 *
 * 바깥것(네트워크·파일쓰기)은 전부 인자로 받는다. 그래야 ffmpeg 없이 테스트할 수 있다.
 */
import { renderShort } from "../../../apps/server/src/media/ffmpeg.js";
import {
  type MaterializedAssets, type RenderPlan,
  missingAssets, planToRenderOpts,
} from "../../../apps/server/src/media/render-plan.js";

/** 작업 공간에서 찾은 파일 하나. */
export interface SourceCandidate {
  path: string;
  size: number;
}

/**
 * 원본 고르기 — **크기가 먼저다.**
 *
 * 편집자 PC 에는 같은 이름이 여럿 있다("본방.mp4" 가 회차마다 있다). 이름만 보고 고르면
 * 다른 회차를 구워서 배포한다 — 사고 중에 제일 조용한 종류다. 그래서 **바이트 크기가
 * 정확히 같은 것만** 후보로 본다. 크기를 모르면(계획에 없으면) 고르지 않는다.
 *
 * 크기가 같은 것이 여럿이면 이름까지 같은 것을 우선하고, 그래도 여럿이면 **고르지 않는다.**
 * 찍어서 맞히느니 서버가 굽는 게 낫다.
 */
export function pickSource(
  candidates: SourceCandidate[],
  want: { filename: string | null; size: number | null },
): string | null {
  if (!want.size || want.size <= 0) return null;
  const sameSize = candidates.filter((c) => c.size === want.size);
  if (sameSize.length === 0) return null;
  if (sameSize.length === 1) return sameSize[0]!.path;

  const named = want.filename
    ? sameSize.filter((c) => baseName(c.path).normalize("NFC") === want.filename!.normalize("NFC"))
    : [];
  return named.length === 1 ? named[0]!.path : null;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

/** 계획의 자산을 로컬에 되살릴 때 필요한 바깥것. */
export interface MaterializeDeps {
  /** 텍스트를 파일로 쓴다. */
  writeText(path: string, body: string): Promise<void>;
  /** URL 의 바이트를 파일로 내려받는다. 실패하면 던진다. */
  download(url: string, path: string): Promise<void>;
  /** 자산을 둘 자리. 파일명을 여기 붙인다. */
  join(...parts: string[]): string;
}

/**
 * 계획의 자산을 편집자 PC 에 되살린다.
 *
 * 하나라도 실패하면 **그 자산만 빠진 채로 넘어간다** — 여기서 던지지 않는 이유는, 무엇이
 * 빠졌는지를 `missingAssets` 가 한 번에 말하게 하기 위해서다. 굽기 직전에 통째로 판정한다.
 */
export async function materialize(
  plan: RenderPlan, dir: string, deps: MaterializeDeps,
): Promise<MaterializedAssets> {
  const out: MaterializedAssets = {};
  const texts = [
    ["ass", "burn.ass"], ["captionAss", "caption.ass"],
    ["decorationAss", "decoration.ass"], ["hookCaptionAss", "hook-caption.ass"],
  ] as const;
  const files = [
    ["overlayPngUrl", "overlayPng", "overlay.png"], ["framePngUrl", "framePng", "frame.png"],
    ["badgePngUrl", "badgePng", "badge.png"], ["hookTtsUrl", "hookTts", "hook.mp3"],
  ] as const;

  for (const [key, name] of texts) {
    const body = plan.assets[key];
    if (body == null) continue;
    const p = deps.join(dir, name);
    try { await deps.writeText(p, body); out[key] = p; } catch { /* missingAssets 가 잡는다 */ }
  }
  for (const [urlKey, key, name] of files) {
    const url = plan.assets[urlKey];
    if (url == null) continue;
    const p = deps.join(dir, name);
    try { await deps.download(url, p); out[key] = p; } catch { /* missingAssets 가 잡는다 */ }
  }
  return out;
}

export type RenderOutcome =
  | { ok: true; outputPath: string }
  /**
   * 못 구웠다 — **호출부는 서버 렌더로 떨어뜨려야 한다.** 이 값을 무시하고 넘어가면
   * 클립이 조용히 사라진다.
   */
  | { ok: false; reason: "no_source" | "missing_assets" | "render_failed"; detail: string };

export interface RenderFromPlanArgs {
  plan: RenderPlan;
  /** 작업 공간에서 찾아 둔 원본. 없으면 `pickSource` 가 못 고른 것이다. */
  inputPath: string | null;
  /** 결과를 쓸 자리. */
  outputPath: string;
  /** 자산을 되살릴 폴더. */
  assetDir: string;
  deps: MaterializeDeps;
  /** 시험용 주입 — 기본은 서버와 같은 `renderShort`. */
  render?: typeof renderShort;
}

/**
 * 계획 하나를 굽는다. **던지지 않는다** — 실패를 값으로 돌려준다.
 *
 * 던지면 호출부가 "그냥 실패했다" 로만 알고 서버 렌더로 넘길 판단을 못 한다.
 * 로컬 렌더는 **되면 좋은 것**이지 되어야만 하는 것이 아니다.
 */
export async function renderFromPlan(args: RenderFromPlanArgs): Promise<RenderOutcome> {
  const { plan, inputPath, outputPath, assetDir, deps } = args;
  if (!inputPath) {
    return { ok: false, reason: "no_source",
             detail: `작업 공간에서 원본을 찾지 못했습니다 (${plan.source.filename ?? plan.source.mediaId})` };
  }

  const have = await materialize(plan, assetDir, deps);
  const missing = missingAssets(plan, have);
  if (missing.length > 0) {
    // 굽는 것 자체는 성공한다 — 오버레이나 자막만 빠진 영상이 나오고 그대로 배포된다.
    // 그래서 여기서 막는다.
    return { ok: false, reason: "missing_assets", detail: `자산을 받지 못했습니다: ${missing.join(", ")}` };
  }

  const opts = planToRenderOpts(plan, { ...have, inputPath, outputPath });
  try {
    await (args.render ?? renderShort)(opts);
    return { ok: true, outputPath };
  } catch (e) {
    return { ok: false, reason: "render_failed", detail: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}
