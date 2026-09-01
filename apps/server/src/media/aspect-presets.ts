/**
 * 종횡비/크롭 프리셋 — **서버 미러**. 정본 사본은 apps/web/src/lib/editor/aspect-presets.ts.
 *
 * 예전엔 `aspect(9:16) × fit(contain/cover) × bgType(solid/blur)` 3필드 곱으로 비율·크롭·여백을
 * 표현했는데, 세 값이 서로 어긋나 "메인 크롭"으로 채택한 클립이 레터박스로 렌더되는 등
 * 라벨↔동작이 갈렸다(docs/research/aena-overlay-aspect-analysis.md). 이제 **한 값(enum)**이
 * 컨테이너·크롭·밴드를 전부 결정한다.
 *
 * 값 하나당:
 *  - canvas 출력 해상도 (세로=1080×1920 · 가로=1920×1080 — index.ts renderDims 와 동일)
 *  - fill: 원본이 캔버스에 들어가는 방식
 *      · "contain" 전체 담기 + 여백(pad) — 레터박스. blurCapable 이면 여백을 블러로 채우는 하위옵션 허용.
 *      · "cover"   잘라 꽉 채우기(여백 없음, 중앙 크롭)
 *      · "rect"    비디오가 `rect` 사각형에 앉고 나머지는 검정 pad(캡션 밴드) — AENA crop-main/sub 이식
 *
 * ⚠️ 이 배열 리터럴은 웹 정본(apps/web/src/lib/editor/aspect-presets.ts)과 **바이트 동일**해야 한다.
 *    aspect-parity.test.ts 가 두 파일의 ASPECT_PRESETS 블록이 갈라지는 순간 빨간불을 켠다.
 *    STEP-D 세로 캔버스 = 1080×1920 이라 AENA(동일 캔버스)의 rect 좌표를 그대로 옮겼다.
 */

export type AspectId =
  | "16:9"
  | "9:16-letterbox"
  | "9:16-crop-full"
  | "9:16-crop-main"
  | "9:16-crop-sub";

export interface AspectPreset {
  id: AspectId;
  /** 원본이 캔버스에 들어가는 방식. */
  fill: "contain" | "cover" | "rect";
  /** 출력 해상도. */
  canvasW: number;
  canvasH: number;
  /** fill:"rect" 전용 — 비디오가 앉을 캔버스 내 사각형(px). 나머지는 검정 pad. */
  rect?: { x: number; y: number; w: number; h: number };
  /** fill:"contain"(레터박스) 전용 — 여백을 블러로 채우는 하위옵션을 허용. */
  blurCapable?: boolean;
  /** 사용자에게 보이는 한국어 라벨. */
  label: string;
  /** 한 줄 정의. */
  hint: string;
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: "16:9", fill: "contain", canvasW: 1920, canvasH: 1080, label: "가로 16:9", hint: "원본 가로 그대로 (자르지 않음)" },
  { id: "9:16-letterbox", fill: "contain", canvasW: 1080, canvasH: 1920, blurCapable: true, label: "세로 · 전체 담기", hint: "원본 전체를 세로 화면에 넣고 위·아래 여백(레터박스)" },
  { id: "9:16-crop-full", fill: "cover", canvasW: 1080, canvasH: 1920, label: "세로 · 꽉 채우기", hint: "잘라서 세로 전체를 채움 (여백 없음)" },
  { id: "9:16-crop-main", fill: "rect", canvasW: 1080, canvasH: 1920, rect: { x: 0, y: 440, w: 1080, h: 1480 }, label: "세로 · 위 자막띠", hint: "위 자막 띠 1개 + 아래 큰 영상" },
  { id: "9:16-crop-sub", fill: "rect", canvasW: 1080, canvasH: 1920, rect: { x: 0, y: 440, w: 1080, h: 980 }, label: "세로 · 위아래 띠", hint: "위·아래 띠 + 가운데 작은 영상" },
];

const ASPECT_IDS = new Set<string>(ASPECT_PRESETS.map((p) => p.id));

export function isAspectId(v: unknown): v is AspectId {
  return typeof v === "string" && ASPECT_IDS.has(v);
}

/** enum id → 프리셋. 알 수 없는(구형 1:1/4:5·bare 9:16) 값이면 undefined. */
export function getAspectPreset(id: unknown): AspectPreset | undefined {
  return typeof id === "string" ? ASPECT_PRESETS.find((p) => p.id === id) : undefined;
}

/** 세로(16:9 아님)인가. */
export function isPortraitAspect(id: unknown): boolean {
  return typeof id === "string" && id !== "16:9" && id.startsWith("9:16");
}

/**
 * 구(舊) 값 → 새 enum 정규화. **하위호환의 단일 지점.**
 *
 * 예전 저장 클립은 `aspect(bare)` + `fit` + `bgType` 를 따로 들고 있다. 그 조합을 새 enum 으로
 * 접되, **결과물이 바뀌지 않는 가장 가까운 등가**로 매핑한다:
 *   9:16 + fit:cover           → 9:16-crop-full   (전체화면 크롭 = 예전 cover 그대로)
 *   9:16 + fit:contain/미설정   → 9:16-letterbox   (레터박스 = 예전 contain 그대로, bgType:blur 는 blur 유지)
 *   9:16-crop-main/sub/letterbox/crop-full → 그대로
 *   9:16-crop(레거시 별칭)      → 9:16-crop-main
 *   16:9                       → 16:9
 *   1:1 · 4:5                  → 그대로 (정사각/피드 — 렌더 무회귀, 새 픽커엔 노출 안 함)
 *
 * blur: 레터박스일 때만 의미가 있는 여백 채움 하위옵션(비율 축과 직교하는 유일한 잔여 필드).
 */
export function normalizeAspectPreset(
  rawAspect: unknown,
  fit?: unknown,
  bgType?: unknown,
): { aspect: AspectId | "1:1" | "4:5"; blur: boolean } {
  const s = String(rawAspect ?? "").trim();
  const blurWanted = bgType === "blur";
  if (isAspectId(s)) {
    return { aspect: s, blur: s === "9:16-letterbox" ? blurWanted : false };
  }
  if (s === "9:16-crop") return { aspect: "9:16-crop-main", blur: false };
  if (s === "1:1" || s === "4:5") return { aspect: s, blur: false };
  if (s.startsWith("9:16")) {
    if (fit === "cover") return { aspect: "9:16-crop-full", blur: false };
    return { aspect: "9:16-letterbox", blur: blurWanted };
  }
  if (s.startsWith("16:9")) return { aspect: "16:9", blur: false };
  // 미설정/미상 → 세로 레터박스 기본(예전 비프레임 기본 동작과 동일).
  return { aspect: "9:16-letterbox", blur: blurWanted };
}
