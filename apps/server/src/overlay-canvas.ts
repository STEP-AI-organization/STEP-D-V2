/**
 * overlay-canvas — 정적 텍스트 오버레이를 **투명 PNG** 로 렌더한다 (AENA 방식 이식).
 *
 * STEP-D 의 자막(STT)은 수백 개 시간축 이벤트라 ASS 로 남기지만(하이브리드), 제목·채널명 같은
 * **정적 오버레이**는 클립 전체에 고정이라 한 장의 PNG 로 표현할 수 있다. 이 PNG 를
 *   1) 렌더 파이프라인에서 ffmpeg `overlay` 로 합성(ASS 번인 대신)하고
 *   2) 에디터가 같은 PNG 를 `<img>` 로 표시(구조적 WYSIWYG)
 * 하는 게 이 모듈의 목적이다.
 *
 * 이 모듈은 **좌표를 계산하지 않는다.** 좌표·폰트·색은 전부 index.ts(파리티의 정본)가 계산해
 * `OverlayTextItem[]` 으로 넘긴다 — 여기선 캔버스에 그리기만 한다. index.ts ↔ overlay-canvas
 * 순환 의존을 피하고, 파리티 스캔 테스트가 계속 index.ts 를 보게 하려는 의도적 분리다.
 *
 * @napi-rs/canvas 는 prebuilt 네이티브 바이너리다. 로드 실패(플랫폼 미지원 등) 시 renderer 는
 * null 을 반환하고, 호출자(index.ts)는 정적 오버레이를 **ASS 로 폴백**해 결과물에서 사라지지
 * 않게 한다(무회귀 안전장치).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 캔버스에 그릴 한 줄의 텍스트. 좌표(x,y)·폰트 px 는 전부 **출력 해상도(1080×1920 등) 기준**. */
export type OverlayTextItem = {
  text: string;
  /** 앵커 x (align 에 따라 좌/중앙/우 기준점). 출력 px. */
  x: number;
  /** 앵커 y. baseline 이 기준(기본 "top" = 글자 상단). 출력 px. */
  y: number;
  align: "left" | "center" | "right";
  baseline?: "top" | "middle" | "alphabetic";
  /** 폰트 크기(출력 px). */
  fontPx: number;
  /** CSS font-weight (예: 700/800/900). 패밀리가 보유한 가장 가까운 웨이트로 스냅한다. */
  weight: number;
  /** 폰트 패밀리 id (FONT_FAMILIES 의 id). 미설정 = 기본(Pretendard). 하위호환. */
  font?: string;
  /** 채움 색 (#rrggbb). */
  color: string;
  /** 0~1. 부가줄(text-white/80) 등. */
  opacity?: number;
  /** 부드러운 그림자 (미리보기 textShadow 미러). 없으면 그림자 없음. */
  shadow?: { offsetX?: number; offsetY: number; blur: number; color: string };
  /** 외곽선(스트로크). 미리보기 -webkit-text-stroke 미러. width 는 출력 px. 없으면 외곽선 없음. */
  stroke?: { color: string; width: number };
};

export type RenderTextLayerInput = {
  width: number;
  height: number;
  items: OverlayTextItem[];
};

// ── 폰트 패밀리 레지스트리 ────────────────────────────────────────────────────
//
// ASS 스타일(index.ts)이 "Pretendard ExtraBold" 로 굽는 것과 **같은 폰트 파일**을 canvas 에
// 등록해야 PNG 글자가 결과물과 어긋나지 않는다. 여기에 패밀리를 **id 로** 모아 두고, 아이템의
// `font`(패밀리 id) + `weight` 로 등록 폰트를 고른다. 미설정 = 첫 항목(Pretendard) = 하위호환.
//
// ▶ **패밀리 추가 = 여기 항목 1개 + 폰트 파일 1개.** 절차:
//   1) 폰트 파일(.otf/.ttf)을 FONT_DIRS 중 하나(로컬 assets/fonts 또는 assets/invoice-fonts,
//      컨테이너 /usr/share/fonts/*)에 떨군다. Dockerfile 이 이미 그 세 경로를 COPY 한다.
//   2) 아래 FONT_FAMILIES 에 { id, label, weights } 한 줄 추가. weights 는 웨이트→{file,family}.
//      family 는 canvas 등록용 **고유 문자열**(겹치면 서로 덮어씀 — 패밀리마다 다르게).
//   3) 웹 픽커 목록(apps/web presets.ts FONT_FAMILY_OPTIONS)에 같은 id 로 항목 추가.
// 그 외 코드(스냅·등록·ctx.font 조립)는 레지스트리를 자동으로 순회하므로 건드릴 필요 없다.
export interface FontFamilyDef {
  id: string;
  label: string;
  /** 웨이트(CSS font-weight) → { 파일명(FONT_DIRS 에서 탐색), canvas 등록 family 문자열 }. */
  weights: Record<number, { file: string; family: string }>;
}

export const FONT_FAMILIES: FontFamilyDef[] = [
  {
    // 기본(하위호환) — 아이템에 font 가 없거나 미등록 id 면 이 패밀리로 폴백한다.
    id: "pretendard",
    label: "프리텐다드",
    weights: {
      700: { file: "Pretendard-Bold.otf", family: "Pretendard Bold" },
      800: { file: "Pretendard-ExtraBold.otf", family: "Pretendard ExtraBold" },
      900: { file: "Pretendard-Black.otf", family: "Pretendard Black" },
    },
  },
  {
    // 지마켓 산스 — 번들: assets/invoice-fonts 의 Medium/Bold 2종(TTF). 임팩트 예능 훅용.
    id: "gmarket",
    label: "지마켓 산스",
    weights: {
      500: { file: "GmarketSansTTFMedium.ttf", family: "GmarketSans Medium" },
      700: { file: "GmarketSansTTFBold.ttf", family: "GmarketSans Bold" },
    },
  },
  {
    // 검은고딕(Black Han Sans) — 단일 웨이트 초굵은 디스플레이. 임팩트 제목 훅용.
    // 파일이 하나뿐이라 모든 웨이트를 같은 파일로 매핑(요청 웨이트와 무관하게 동일 렌더).
    id: "blackhansans",
    label: "검은고딕",
    weights: {
      700: { file: "BlackHanSans-Regular.ttf", family: "Black Han Sans" },
      800: { file: "BlackHanSans-Regular.ttf", family: "Black Han Sans" },
      900: { file: "BlackHanSans-Regular.ttf", family: "Black Han Sans" },
    },
  },
  {
    // 도현(Do Hyeon) — 단일 웨이트 둥근 고딕 디스플레이.
    id: "dohyeon",
    label: "도현",
    weights: {
      400: { file: "DoHyeon-Regular.ttf", family: "Do Hyeon" },
    },
  },
  {
    // 주아(Jua) — 단일 웨이트 손글씨풍 둥근 디스플레이.
    id: "jua",
    label: "주아",
    weights: {
      400: { file: "Jua-Regular.ttf", family: "Jua" },
    },
  },
  {
    // 고딕A1(Gothic A1) — Bold/Black 2종. 본문형 고딕부터 초굵은 헤드라인까지.
    id: "gothica1",
    label: "고딕A1",
    weights: {
      700: { file: "GothicA1-Bold.ttf", family: "GothicA1 Bold" },
      900: { file: "GothicA1-Black.ttf", family: "GothicA1 Black" },
    },
  },
];

/** id → 패밀리 정의. 미설정·미등록 id 는 기본(첫 항목 Pretendard). */
function familyById(id?: string): FontFamilyDef {
  if (id) {
    const f = FONT_FAMILIES.find((x) => x.id === id);
    if (f) return f;
  }
  return FONT_FAMILIES[0];
}

/** 요청 weight 를 패밀리가 실제 보유한 가장 가까운 weight 로 스냅. */
function snapWeightIn(fam: FontFamilyDef, weight: number): number {
  const avail = Object.keys(fam.weights).map(Number);
  let best = avail[0];
  let bestDiff = Infinity;
  for (const w of avail) {
    const d = Math.abs(w - weight);
    if (d < bestDiff) {
      bestDiff = d;
      best = w;
    }
  }
  return best;
}

/**
 * 폰트 파일 후보 경로 — 로컬(리포 상대)과 컨테이너(fontconfig 설치 경로) 양쪽을 커버.
 *  1) <repo>/assets/fonts          — Pretendard(OTF). import.meta.url 상대(로컬 + /app/assets/fonts)
 *  2) <repo>/assets/invoice-fonts  — GmarketSans(TTF). Dockerfile 이 이미 COPY(메일 인보이스와 공유)
 *  3) /usr/share/fonts/opentype/pretendard — Dockerfile 이 COPY + fc-cache 하는 경로(컨테이너 상시)
 */
const FONT_DIRS = [
  path.resolve(fileURLToPath(import.meta.url), "../../../../assets/fonts"),
  path.resolve(fileURLToPath(import.meta.url), "../../../../assets/invoice-fonts"),
  "/usr/share/fonts/opentype/pretendard",
];

function resolveFontFile(file: string): string | null {
  for (const dir of FONT_DIRS) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

type CanvasModule = typeof import("@napi-rs/canvas");
let canvasModPromise: Promise<CanvasModule | null> | null = null;
/** 등록 완료한 canvas family 문자열들(예: "Pretendard ExtraBold"). 재등록 방지. */
const registered = new Set<string>();

/** @napi-rs/canvas 를 지연 로드하고 레지스트리의 모든 패밀리·웨이트를 1회 등록한다. 실패 시 null(→ ASS 폴백). */
async function loadCanvas(): Promise<CanvasModule | null> {
  if (!canvasModPromise) {
    canvasModPromise = import("@napi-rs/canvas")
      .then((mod) => {
        for (const fam of FONT_FAMILIES) {
          for (const w of Object.keys(fam.weights).map(Number)) {
            const { file, family } = fam.weights[w];
            if (registered.has(family)) continue;
            const p = resolveFontFile(file);
            if (p) {
              try {
                mod.GlobalFonts.registerFromPath(p, family);
                registered.add(family);
              } catch {
                /* 폰트 등록 실패 — 해당 웨이트는 fallback family 로 나간다 */
              }
            }
          }
        }
        return mod;
      })
      .catch(() => null);
  }
  return canvasModPromise;
}

/** 지금 환경에서 canvas 렌더가 가능한지(네이티브 바이너리 로드 성공). */
export async function overlayCanvasAvailable(): Promise<boolean> {
  return (await loadCanvas()) != null;
}

/**
 * 텍스트 레이어를 투명 PNG 버퍼로 렌더한다. items 가 비었으면 null(그릴 게 없음).
 * canvas 로드 실패 시에도 null — 호출자가 ASS 폴백을 타야 한다.
 */
export async function renderTextLayerPng(input: RenderTextLayerInput): Promise<Buffer | null> {
  const { width, height, items } = input;
  if (!items.length || !(width > 0) || !(height > 0)) return null;
  const mod = await loadCanvas();
  if (!mod) return null;

  const canvas = mod.createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  for (const it of items) {
    const text = String(it.text ?? "");
    if (!text) continue;
    const fam = familyById(it.font);
    const w = snapWeightIn(fam, Number(it.weight) || 800);
    const spec = fam.weights[w];
    const family = spec && registered.has(spec.family) ? spec.family : "sans-serif";
    // 폰트 스택에 이모지·sans-serif 폴백을 붙여 한글 외 글자도 깨지지 않게.
    ctx.font = `${Math.max(1, Math.round(it.fontPx))}px "${family}", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = it.align ?? "left";
    ctx.textBaseline = it.baseline ?? "top";
    ctx.globalAlpha = it.opacity != null ? Math.max(0, Math.min(1, it.opacity)) : 1;
    const setShadow = (on: boolean) => {
      if (on && it.shadow) {
        ctx.shadowColor = it.shadow.color;
        ctx.shadowBlur = Math.max(0, it.shadow.blur);
        ctx.shadowOffsetX = it.shadow.offsetX ?? 0;
        ctx.shadowOffsetY = it.shadow.offsetY;
      } else {
        ctx.shadowColor = "rgba(0,0,0,0)";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
    };
    setShadow(true);
    // 외곽선(스트로크)은 fill 전에 그린다(AENA text-render.service.ts:130-139) — 미리보기
    // -webkit-text-stroke 와 같은 시각. 스트로크가 그림자를 지고 나면 fill 의 그림자는 꺼서
    // 그림자가 이중으로 겹치지 않게 한다(외곽선 없을 땐 fill 이 그림자를 진다 — 종전과 동일).
    const stroke = it.stroke;
    if (stroke && stroke.width > 0 && stroke.color) {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = stroke.width;
      ctx.strokeStyle = stroke.color;
      ctx.strokeText(text, it.x, it.y);
      setShadow(false);
    }
    ctx.fillStyle = it.color || "#ffffff";
    ctx.fillText(text, it.x, it.y);
  }

  return canvas.toBuffer("image/png");
}
