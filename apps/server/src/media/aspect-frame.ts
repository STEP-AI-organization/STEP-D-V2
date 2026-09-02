/**
 * 배치(aspect) → 프레임 템플릿의 **영상창**.
 *
 * 프레임 템플릿(`assets/shorts-template/<name>/meta.json`)은 원래 영상창 좌표를 **자기가** 들고
 * 있었다. 그런데 자동배포 계획에도 배치(9:16-letterbox/crop-full/crop-main/crop-sub)가 생기면서
 * 둘이 같은 것을 두 번 정하게 됐고, 합성 우선순위상(`ffmpeg.ts`: `if (frame) … else if (cropRect)`)
 * **템플릿이 언제나 이겨서** 화면에서 배치를 골라도 결과가 안 바뀌었다(2026-09-02 hkj 신고).
 *
 * 역할을 나눈다: **템플릿 = 제목·자막·박스 스타일 · 배치 = 영상창**.
 *
 * ⚠️ **무회귀가 조건이다.** 배치를 명시하지 않은 계획·수동 편집분은 지금까지대로 템플릿 창을
 *    쓴다 — 그래서 이 변환은 `editorState.videoRect` 가 **실제로 실릴 때만** 일어나고,
 *    그 값은 계획이 배치를 지정했을 때만 실린다(automation-cycle). 여기서 기본값을 만들지 않는다.
 */
import { getAspectPreset } from "./aspect-presets.ts";

export interface FrameVideoRect {
  x: number; y: number; w: number; h: number;
  fit: "cover" | "contain";
}

export interface FrameBand {
  x: number; y: number; w: number; h: number;
  color?: string; over?: boolean;
}

/**
 * 배치 id → 캔버스(W×H) 안의 영상창. 아는 배치가 아니면 null(호출부가 템플릿 창을 그대로 쓴다).
 *
 * 세로 프리셋만 의미가 있다 — 가로(16:9)는 캔버스 자체가 가로라 창을 따로 자를 게 없다.
 *   letterbox   전체 캔버스에 contain  → 위아래 여백(레터박스)
 *   crop-full   전체 캔버스에 cover    → 잘라서 꽉 채움
 *   crop-main   프리셋 rect 에 cover   → 위 자막띠 + 아래 큰 영상
 *   crop-sub    프리셋 rect 에 cover   → 위아래 띠 + 가운데 영상
 */
export function frameVideoForAspect(aspect: unknown, W: number, H: number): FrameVideoRect | null {
  const p = getAspectPreset(aspect);
  if (!p || p.id === "16:9") return null;
  if (p.fill === "rect" && p.rect) {
    // 프리셋 rect 는 1080×1920 기준이다. 캔버스가 다르면 비율로 옮긴다.
    const sx = W / p.canvasW;
    const sy = H / p.canvasH;
    return {
      x: Math.round(p.rect.x * sx), y: Math.round(p.rect.y * sy),
      w: Math.round(p.rect.w * sx), h: Math.round(p.rect.h * sy),
      // rect 경로는 `crop=ih*w/h:ih,scale=w:h`(중앙 크롭 후 채움) = 사각형 안에서 cover 다.
      fit: "cover",
    };
  }
  return { x: 0, y: 0, w: W, h: H, fit: p.fill === "cover" ? "cover" : "contain" };
}

/**
 * 영상창의 **위·아래 나머지**를 밴드로 만든다.
 *
 * 템플릿의 밴드는 자기 영상창에 맞춰 고정돼 있어서, 창이 바뀌면 같이 다시 계산해야 한다.
 * (지금 두 템플릿 모두 검정 밴드 + 검정 바탕이라 눈에 띄지 않지만, 색 있는 밴드가 생기면
 *  바로 어긋난다.) 창이 캔버스를 꽉 채우면 밴드는 없다.
 */
export function bandsAroundVideo(
  video: { y: number; h: number }, W: number, H: number, color?: string,
): FrameBand[] {
  const bands: FrameBand[] = [];
  const top = Math.max(0, Math.round(video.y));
  const bottomY = Math.min(H, Math.round(video.y + video.h));
  if (top > 0) bands.push({ x: 0, y: 0, w: W, h: top, ...(color ? { color } : {}) });
  if (bottomY < H) bands.push({ x: 0, y: bottomY, w: W, h: H - bottomY, ...(color ? { color } : {}) });
  return bands;
}
