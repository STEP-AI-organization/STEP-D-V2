/**
 * 동봉한 ffmpeg·글꼴을 앱이 쓰게 한다. **기동 때 한 번** 부른다.
 *
 * ## 왜 env 로 넘기나
 *
 * 렌더 구현은 서버의 `media/ffmpeg.ts` **한 벌**이고 네이티브가 그걸 그대로 쓴다.
 * 같은 코드가 굽는 곳만 다르므로, 갈리는 값은 **바이너리 위치와 글꼴 위치 둘뿐**이다.
 * 그 둘을 env 로 넘기면 렌더 코드는 아무것도 몰라도 된다 —
 * `ffmpegBin()`/`ffprobeBin()` 이 이미 그 env 를 본다(`STEPD_FFMPEG`·`STEPD_FFPROBE`).
 *
 * ## 글꼴은 설치하지 않는다
 *
 * Windows 용 ffmpeg 은 fontconfig 대신 **DirectWrite** 로 글꼴을 찾는다. 그래서 동봉 글꼴을
 * 그냥 두면 libass 가 못 찾고 **조용히 다른 글꼴로 대체**한다(에러 없음 — 이 리포에 이미
 * 같은 사고 기록이 있다). 편집자 PC 에 글꼴을 설치시키는 것도 답이 아니다(권한·정리 문제).
 * 대신 `ass` 필터의 `fontsdir` 로 폴더를 지목한다 — libass 가 그 폴더를 직접 훑는다.
 *
 * ⚠️ **개발 중(패키징 안 된 상태)에는 아무것도 안 한다.** 그때는 PATH 의 ffmpeg 을 쓰는
 *    게 맞다 — 없는 경로를 env 에 박으면 개발 PC 에서 렌더가 통째로 죽는다.
 */
import fs from "node:fs";
import path from "node:path";

export interface BundledRenderPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
  fontsDir: string | null;
}

/**
 * `extraResources` 로 넣은 자리를 찾는다.
 * 패키징되면 `process.resourcesPath/ffmpeg/ffmpeg.exe` · `.../fonts/` 다.
 */
export function resolveBundled(resourcesPath: string, packaged: boolean): BundledRenderPaths {
  if (!packaged) return { ffmpeg: null, ffprobe: null, fontsDir: null };
  const exe = path.join(resourcesPath, "ffmpeg", "ffmpeg.exe");
  const probe = path.join(resourcesPath, "ffmpeg", "ffprobe.exe");
  const fonts = path.join(resourcesPath, "fonts");
  return {
    ffmpeg: fs.existsSync(exe) ? exe : null,
    ffprobe: fs.existsSync(probe) ? probe : null,
    fontsDir: fs.existsSync(fonts) ? fonts : null,
  };
}

/**
 * env 에 심는다. 이미 사람이 지정해 둔 값이 있으면 **덮지 않는다** —
 * 개발자가 특정 빌드로 시험하는 걸 앱이 되돌리면 안 된다.
 */
export function applyBundledRenderEnv(p: BundledRenderPaths, env: NodeJS.ProcessEnv = process.env): void {
  if (p.ffmpeg && !env.STEPD_FFMPEG) env.STEPD_FFMPEG = p.ffmpeg;
  if (p.ffprobe && !env.STEPD_FFPROBE) env.STEPD_FFPROBE = p.ffprobe;
  if (p.fontsDir && !env.STEPD_FONTS_DIR) env.STEPD_FONTS_DIR = p.fontsDir;
}

/** 렌더를 돌릴 수 있는 상태인가 — 화면이 "이 PC 에서 굽는다/못 굽는다" 를 말할 근거. */
export function canRenderLocally(env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = (env.STEPD_FFMPEG ?? "").trim();
  return bin.length > 0 && fs.existsSync(bin);
}
