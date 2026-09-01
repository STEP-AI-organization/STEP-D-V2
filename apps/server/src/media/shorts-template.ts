/**
 * 쇼츠 프레임 템플릿 — `assets/shorts-template/<name>/{overlay.png,meta.json}` 로더.
 *
 * 템플릿은 **기하만** 제공한다: 영상이 들어갈 사각형 · 단색으로 막을 띠 · PNG 에서 살릴 영역.
 * 텍스트는 여기서 그리지 않는다 — 편집기의 titleLines/채널 레이어가 기존 ASS 경로로 굽는다.
 * 렌더러를 둘로 갈라놓으면 "편집기에서 본 것"과 "export 결과"가 어긋난다.
 *
 * `text` 슬롯은 편집기가 제목 줄을 처음 앉힐 **기본 위치**로만 쓴다(픽셀 → %).
 */
import fs from "node:fs";
import path from "node:path";
import { assetPath } from "../repo-root.ts";

// 리포 루트는 repo-root.ts 가 안다(폴더를 옮겨도 안 어긋나게).
const ROOT = assetPath("shorts-template");

export interface Rect { x: number; y: number; w: number; h: number }
export interface Band extends Rect { color?: string; over?: boolean }
export interface TextSlot {
  slot: string;
  x?: number | "center";
  y: number;
  size: number;
  color?: string;
  borderw?: number;
  bordercolor?: string;
}

export interface ShortsTemplate {
  name: string;
  title: string;
  size: [number, number];
  video: Rect & { fit?: "cover" | "contain" };
  bands: Band[];
  overlayRegions: Rect[];
  text: TextSlot[];
  overlayPath: string;
  canvaDesignId?: string | null;
}

function load(name: string): ShortsTemplate | null {
  const dir = path.join(ROOT, name);
  const metaPath = path.join(dir, "meta.json");
  const overlayPath = path.join(dir, "overlay.png");
  if (!fs.existsSync(metaPath) || !fs.existsSync(overlayPath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return {
      name,
      title: m.canva_title || m.name || name,
      size: m.size ?? [1080, 1920],
      video: m.video,
      bands: m.bands ?? [],
      overlayRegions: m.overlay_regions ?? [],
      text: m.text ?? [],
      overlayPath,
      canvaDesignId: m.canva_design_id ?? null,
    };
  } catch {
    return null; // 깨진 meta.json 하나가 목록 전체를 죽이면 안 된다
  }
}

/** 디스크를 매번 읽는다 — canva:sync 후 서버 재시작 없이 반영되어야 한다. */
export function listShortsTemplates(): ShortsTemplate[] {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT)
    .map(load)
    .filter((t): t is ShortsTemplate => t !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getShortsTemplate(name: string): ShortsTemplate | null {
  // 경로 조작 방지 — 이름은 디렉토리 한 칸이어야 한다.
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  return load(name);
}

/**
 * 편집기가 쓰는 % 좌표로 변환. 편집기 캔버스는 비율 기반이라 픽셀을 그대로 넘기면
 * 미리보기와 export 가 어긋난다.
 */
export function toPercent(t: ShortsTemplate) {
  const [W, H] = t.size;
  const pct = (r: Rect) => ({
    x: (r.x / W) * 100, y: (r.y / H) * 100,
    w: (r.w / W) * 100, h: (r.h / H) * 100,
  });
  return {
    name: t.name,
    title: t.title,
    size: t.size,
    video: { ...pct(t.video), fit: t.video.fit ?? "cover" },
    bands: t.bands.map((b) => ({ ...pct(b), color: b.color ?? "black", over: !!b.over })),
    overlayRegions: t.overlayRegions.map(pct),
    text: t.text.map((s) => ({
      slot: s.slot,
      x: s.x === undefined || s.x === "center" ? 50 : (Number(s.x) / W) * 100,
      align: s.x === undefined || s.x === "center" ? "center" : "left",
      y: (s.y / H) * 100,
      // 편집기 제목 크기는 px 기준(1080 폭 캔버스 가정)이라 그대로 넘긴다.
      size: s.size,
      color: s.color ?? "#ffffff",
      borderw: s.borderw ?? 0,
      bordercolor: s.bordercolor ?? "#000000",
    })),
    overlayUrl: `/api/shorts-templates/${t.name}/overlay.png`,
  };
}
