/**
 * 모션 그래픽 템플릿(.mogrt) **서버 생성** — 프리미어 경로의 제목을 편집 가능한 텍스트로.
 *
 * 왜 이게 있나 (사용자 2026-08-31): 제목을 PNG 로 얹으면 픽셀은 정확한데 **편집자가 못 고친다.**
 * 그렇다고 .mogrt 자산을 손으로 만들어 두면 위치·글꼴·크기가 파일에 **박제**돼서, 서버에서
 * 템플릿을 바꿔도 프리미어 경로만 옛 모양으로 남는다. 둘 다 싫다 —
 * *"우리 서버에서 .MOGRT 파일 만들어서 내려주면 되잖아."* 그 말이 맞다.
 *
 * ── 파일 구조 (실측 2026-08-31 · Premiere 2026 기본 템플릿을 뜯어 확인)
 *   .mogrt                        = zip
 *     ├ definition.json           = 노출 컨트롤·이름 (평문 JSON)
 *     ├ project.prgraphic         = zip
 *     │   └ *.prproj              = gzip(XML)  ← 그래픽 본체
 *     ├ project_ko_KR.prgraphic   = **언어별 판** (ja_JP·ru_RU·zh_CN 도 있다)
 *     │                             프리미어는 자기 UI 언어 판을 먼저 읽는다 → 전부 고친다
 *     └ thumb*.png/mp4            = 미리보기 (안 건드린다)
 *
 * ⚠️ 로케일 판은 XML 의 **`<Name>` 이 번역돼 있다**(`Position`→`위치`, `Anchor Point`→`기준점`).
 *    구조·순서·ObjectID 는 같다. 그래서 파라미터는 이름이 아니라 `<ParameterID>` 로 고른다.
 *
 * XML 안에서 우리가 바꾸는 것 — **전부 평문이거나 JSON 이다.** 바이너리 리버싱이 아니다:
 *   · 문구·글꼴·크기·색 : <StartKeyframeValue Encoding="base64"> = UTF-16LE JSON
 *                        (mText · mFontName · mFontSize · mFillColor)
 *   · 위치             : <PointComponentParam><Name>Position</Name><StartKeyframe>
 *                        = "시각,X,Y,…" 의 **0..1 정규화 좌표**
 *
 * ⚠️ `BinaryHash` 속성이 붙어 있지만 **프리미어는 검증하지 않는다**(2026-08-31 실측:
 *    문구·크기·색을 바꾼 파일이 그대로 렌더됐다). 검증한다면 이 접근 전체가 성립하지 않으므로,
 *    프리미어 메이저 업데이트 때 이 가정을 다시 확인할 것.
 *
 * ⚠️ **베이스 템플릿은 리포에 없다.** 편집자 PC 의 프리미어에 딸려 오는 기본 템플릿을 패널이
 *    한 번 올려 주고(서버가 캐시), 우리는 그걸 고쳐 쓴다. Adobe 자산을 우리가 재배포하지
 *    않으려는 것도 있지만, 더 실질적인 이유는 **버전 호환**이다 — 그 PC 의 프리미어가 만든
 *    캡슐이라 그 프리미어에서 반드시 열린다.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { unzipSync, zipSync } from "fflate";

/** 제목 한 줄 — 서버 오버레이 아이템(OverlayTextItem)에서 그대로 옮겨 온 값. */
export type MogrtTextLayer = {
  text: string;
  /** 글꼴의 **PostScript 이름**(예: GmarketSansTTFBold). 표시 이름이 아니다. */
  postScriptName: string;
  /** 글자 크기 — 프레임 기준 px. */
  fontPx: number;
  /** 채움색 정수 (0xRRGGBB). */
  colorInt: number;
  /** 위치 — 프레임 대비 0..1. */
  xNorm: number;
  yNorm: number;
  /**
   * 프리미어 `mAlignment` — **0=왼쪽 · 1=오른쪽 · 2=가운데.**
   *
   * ⚠️ 가운데가 1 이 아니다. 애프터이펙트 `ParagraphJustification`(LEFT·RIGHT·CENTER 순서)을
   *    그대로 쓴다 — 텍스트 엔진이 같다. 처음엔 흔한 순서(왼·가운데·오른)로 넣었다가
   *    제목 두 줄이 **가운데에서 왼쪽으로** 뻗는 걸 보고 알았다(2026-09-01 · 오른쪽 정렬이라
   *    글자 끝이 x=0.5 에 정확히 붙었다).
   */
  alignment: 0 | 1 | 2;
  /** 외곽선 — 자막의 검정 스트로크(ASS Outline)를 옮길 때 쓴다. 없으면 템플릿 값 유지. */
  stroke?: { colorInt: number; width: number } | null;
};

export type MogrtMeta = {
  /** 캡슐 id. **요청마다 달라야 한다** — 같으면 프리미어가 같은 템플릿으로 보고 캐시를 쓴다. */
  capsuleId: string;
  /** 필수 그래픽 목록에 뜰 이름. */
  capsuleName: string;
};

const TEXT_BLOB_RE = /(<StartKeyframeValue Encoding="base64"[^>]*>)([A-Za-z0-9+/=\s]+)(<\/StartKeyframeValue>)/g;
/**
 * 좌표 파라미터 한 덩어리. **이름으로 찾지 않는다** — 로케일 판에서는 `<Name>` 이 번역돼
 * 있어서(`위치`·`位置`·`Положение`) 영어 이름으로 찾으면 한 개도 안 걸린다.
 * 언어와 무관한 열쇠는 `<ParameterID>` 다 — 위치=3, 기준점=9 (5개 로케일 전부 확인).
 */
const POINT_PARAM_RE = /<PointComponentParam[^>]*>[\s\S]*?<\/PointComponentParam>/g;
const POSITION_PARAM_ID = 3;
const START_KEYFRAME_RE = /(<StartKeyframe>)(-?\d+),([^,]+),([^,]+)(,)/;

/** 텍스트 blob 하나 = 길이 8바이트(LE) + UTF-16LE JSON. */
function decodeTextBlob(b64: string): Record<string, any> | null {
  try {
    const raw = Buffer.from(b64.replace(/\s/g, ""), "base64");
    if (raw.length < 9) return null;
    const len = Number(raw.readBigUInt64LE(0));
    const json = raw.subarray(8, 8 + len).toString("utf16le");
    const parsed = JSON.parse(json);
    return parsed && parsed.mTextParam ? parsed : null;
  } catch {
    return null;
  }
}

function encodeTextBlob(value: Record<string, any>): string {
  const json = Buffer.from(JSON.stringify(value), "utf16le");
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([head, json]).toString("base64");
}

/** mParamValues 는 [[시각, 값], …] 형태다. 첫 값만 쓴다(우리 제목은 애니메이션이 없다). */
function setFirst(node: any, value: unknown): void {
  if (node && Array.isArray(node.mParamValues) && Array.isArray(node.mParamValues[0])) {
    node.mParamValues[0][1] = value;
  }
}

function applyLayer(blob: Record<string, any>, layer: MogrtTextLayer): void {
  const tp = blob.mTextParam;
  const ss = tp?.mStyleSheet;
  if (!ss) return;
  ss.mText = layer.text;
  // 글꼴 이름이 비면 **건드리지 않는다** — 빈 값을 넣으면 프리미어가 글꼴을 못 찾는다.
  // (폰트 파일이 서버에 없어 PostScript 이름을 못 읽은 경우. 템플릿 글꼴로 남는 게 낫다)
  if (layer.postScriptName) setFirst(ss.mFontName, layer.postScriptName);
  setFirst(ss.mFontSize, Math.max(1, Math.round(layer.fontPx)));
  setFirst(ss.mFillColor, layer.colorInt >>> 0);
  if (typeof tp.mAlignment === "number") tp.mAlignment = layer.alignment;
  if (layer.stroke) {
    setFirst(ss.mStrokeVisible, layer.stroke.width > 0);
    setFirst(ss.mStrokeColor, layer.stroke.colorInt >>> 0);
    setFirst(ss.mStrokeWidth, Math.max(0, layer.stroke.width));
    // 프리미어는 기본이 **칠 위에 선**이다. ASS 는 선이 칠 뒤라 글자가 얇아 보이지 않는다 —
    // 같은 인상을 내려면 칠을 선 위로 올린다.
    setFirst(ss.mFillOverStroke, true);
  }
}

/**
 * ── 레이어 나누기 ────────────────────────────────────────────────────────────
 *
 * .prproj XML 은 **평평한 객체 목록**이다(레이어가 서로를 감싸지 않고 ObjectRef 로 가리킨다).
 * 그런데 파라미터는 문서 순서대로 나오고 **레이어마다 ParameterID 가 1 부터 다시 센다.**
 * 그래서 "pid 가 1 로 되돌아가면 새 레이어" 로 자르면 레이어 경계가 정확히 나온다.
 *
 * 레이어 종류는 **구조로** 알아본다 — `<Name>` 은 로케일 판에서 번역돼 있어 못 쓴다:
 *   · 텍스트 : 첫 파라미터가 Arb + 그 blob 에 `mTextParam` 이 있다
 *   · 도형   : 첫 파라미터가 Arb 인데 텍스트가 아니다 (Path·Appearance)
 *   · 이미지 : 첫 파라미터가 Point(위치) + 반응형 핀(pid 8~11)이 붙어 있다
 *   · 모션   : 그래픽 전체 변형. 핀이 없다
 *
 * 종류마다 pid 배치가 다르다(실측 `Titles/Modern Title.mogrt`):
 *   텍스트 1=문구 3=위치 8=불투명도 9=기준점
 *   이미지 1=위치 2=배율 4=균일배율 5=회전 6=불투명도 7=기준점 8~11=핀
 *   도형   4=위치 9=불투명도
 */
type LayerKind = "text" | "shape" | "image" | "motion" | "other";

const PARAM_RE = /<(\w+ComponentParam)\b[^>]*>([\s\S]*?)<\/\1>/g;

/** 이미지 레이어의 pid 배치 (실측 `Titles/Modern Title.mogrt`). */
const IMAGE_SCALE_ID = 2;
const IMAGE_HSCALE_ID = 3;
const IMAGE_UNIFORM_SCALE_ID = 4;
const IMAGE_ROTATION_ID = 5;
const IMAGE_OPACITY_ID = 6;
const IMAGE_ANCHOR_ID = 7;
/** 도형 레이어의 불투명도 pid — 배치가 이미지와 다르다. */
const SHAPE_OPACITY_ID = 9;

/** 스칼라 파라미터 값 — `<StartKeyframe>시각,값,…`. */
function setScalar(block: string, value: string): string {
  return block.replace(/(<StartKeyframe>)([^,]*),([^,<]*)/, (_w, head, time) => `${head}${time},${value}`);
}

/** 좌표 파라미터 값 — `<StartKeyframe>시각,x,y,…`. */
function setPoint(block: string, x: number, y: number): string {
  return block.replace(START_KEYFRAME_RE, (_w, head: string, time: string, _x, _y, tail: string) =>
    `${head}${time},${x},${y}${tail}`);
}

type LayerScan = { tags: string[]; pids: number[]; textish: boolean };

/** 문서 순서대로 파라미터를 훑어 레이어 경계와 종류를 낸다. */
function scanLayers(xml: string): LayerKind[] {
  const kinds: LayerKind[] = [];
  let cur: LayerScan | null = null;
  const close = (g: LayerScan | null) => {
    if (!g) return;
    const first = g.tags[0] ?? "";
    const hasPins = [8, 9, 10, 11].every((p) => g.pids.includes(p));
    if (first.startsWith("Arb")) kinds.push(g.textish ? "text" : "shape");
    else if (first.startsWith("Point")) kinds.push(hasPins && g.pids.length >= 12 ? "image" : "motion");
    else kinds.push("other");
  };
  for (const m of xml.matchAll(PARAM_RE)) {
    const pid = Number(/<ParameterID>(\d+)</.exec(m[2])?.[1] ?? 0);
    if (pid === 1 || !cur) { close(cur); cur = { tags: [], pids: [], textish: false }; }
    cur.tags.push(m[1]);
    cur.pids.push(pid);
    if (cur.tags.length === 1 && m[1].startsWith("Arb")) {
      const b64 = /<StartKeyframeValue Encoding="base64"[^>]*>([A-Za-z0-9+/=\s]+)</.exec(m[2])?.[1] ?? "";
      cur.textish = Boolean(decodeTextBlob(b64));
    }
  }
  close(cur);
  return kinds;
}

/**
 * `.prgraphic` 하나(= 한 언어 판)를 우리 제목으로 고쳐 제자리에 되쓴다.
 * 텍스트 레이어를 하나라도 고쳤으면 true.
 */
function patchGraphic(
  outer: Record<string, Uint8Array>, name: string, layers: MogrtTextLayer[], image?: Uint8Array | null,
): boolean {
  const inner = unzipSync(outer[name]);
  const prName = Object.keys(inner).find((n) => n.endsWith(".prproj"));
  if (!prName) return false;
  let xml = Buffer.from(gunzipSync(Buffer.from(inner[prName]))).toString("utf-8");
  const kinds = image ? scanLayers(xml) : [];

  // 그림은 **`.prgraphic` 안에 통째로 들어 있다**(예: `Bracket_A.png`). 그 바이트만 갈아 끼우면
  // 레이어·참조는 그대로 살아 있다 — 레이어를 새로 만드는 것과 달리 깨질 구석이 없다.
  if (image) {
    const media = Object.keys(inner).filter((n) => !n.endsWith(".prproj"));
    if (!media.length) throw new Error("이 베이스에는 그림 레이어가 없다 — 로고를 넣을 자리가 없다");
    for (const m of media) inner[m] = image;
  }

  // ── ① 텍스트 blob (문구·글꼴·크기·색)
  let slots = 0;
  xml = xml.replace(TEXT_BLOB_RE, (whole, open: string, b64: string, close: string) => {
    const blob = decodeTextBlob(b64);
    if (!blob) return whole;                       // 텍스트가 아닌 blob 은 손대지 않는다
    const layer = layers[slots++];
    if (layer) applyLayer(blob, layer);
    else applyLayer(blob, { ...layers[0], text: "" });   // 남는 레이어는 비운다
    return open + encodeTextBlob(blob) + close;
  });
  if (!slots) return false;

  // 줄이 레이어보다 많으면 마지막 레이어에 합쳐서 **다시 한 번** 쓴다.
  if (layers.length > slots) {
    const merged = layers.slice(slots - 1).map((l) => l.text).join("\r");
    let seen = 0;
    xml = xml.replace(TEXT_BLOB_RE, (whole, open: string, b64: string, close: string) => {
      const blob = decodeTextBlob(b64);
      if (!blob) return whole;
      if (seen++ !== slots - 1) return whole;
      applyLayer(blob, { ...layers[slots - 1], text: merged });
      return open + encodeTextBlob(blob) + close;
    });
  }

  // ── ② 위치 (0..1 정규화 좌표) — ParameterID 로 고른다(이름은 번역돼 있다)
  let pos = 0;
  xml = xml.replace(POINT_PARAM_RE, (block: string) => {
    if (!new RegExp(`<ParameterID>${POSITION_PARAM_ID}</ParameterID>`).test(block)) return block;
    const layer = layers[pos++];
    if (!layer) return block;
    return block.replace(START_KEYFRAME_RE, (_w, head: string, time: string, _x, _y, tail: string) =>
      `${head}${time},${layer.xNorm},${layer.yNorm}${tail}`);
  });

  // ── ②-B 이미지 레이어 — **한 장을 화면 전체로, 나머지는 감춘다.**
  //
  // 베이스(`Titles/Modern Title`)에는 장식용 이미지 레이어가 **둘**, 도형 레이어가 하나 있다.
  // 우리는 그중 하나만 우리 그림(로고·시간박스 한 장)으로 쓰고 나머지는 불투명도 0 으로 끈다 —
  // 지우지 않는 이유: 레이어를 XML 에서 들어내면 참조가 깨진다. **끄는 게 안전하다.**
  if (kinds.includes("image")) {
    const firstImage = kinds.indexOf("image");
    let li = -1;
    let cur: LayerKind = "other";
    xml = xml.replace(PARAM_RE, (block: string, _tag: string, body: string) => {
      const pid = Number(/<ParameterID>(\d+)</.exec(body)?.[1] ?? 0);
      if (pid === 1 || li < 0) { li += 1; cur = kinds[li] ?? "other"; }
      if (cur === "shape") return pid === SHAPE_OPACITY_ID ? setScalar(block, "0.") : block;
      if (cur !== "image") return block;
      if (li !== firstImage) return pid === IMAGE_OPACITY_ID ? setScalar(block, "0.") : block;
      switch (pid) {
        case 1: return setPoint(block, 0.5, 0.5);                  // 화면 한가운데
        // 원본 크기 = 프레임 크기. 가로 배율도 같이 —  베이스는 둘이 다른 값이라
        // (한국어 판 실측: 세로 11.59 · 가로 34.09) 하나만 고치면 찌그러진다.
        case IMAGE_SCALE_ID: return setScalar(block, "100.");
        case IMAGE_HSCALE_ID: return setScalar(block, "100.");
        case IMAGE_UNIFORM_SCALE_ID: return setScalar(block, "true");
        case IMAGE_ROTATION_ID: return setScalar(block, "0.");      // 베이스는 한 장이 180° 다
        case IMAGE_OPACITY_ID: return setScalar(block, "100.");
        case IMAGE_ANCHOR_ID: return setPoint(block, 0.5, 0.5);     // 기준점도 한가운데
        case 8: case 9: case 10: case 11:
          return setScalar(block, "false");                         // 반응형 핀 해제 — 꽉 채운다
        default: return block;
      }
    });
  }

  // ── ③ 되감기: gzip → 안쪽 zip → 바깥 zip
  inner[prName] = new Uint8Array(gzipSync(Buffer.from(xml, "utf-8")));
  outer[name] = zipSync(inner);
  return true;
}

/**
 * 베이스 템플릿을 우리 제목으로 고쳐 새 .mogrt 바이트를 만든다.
 *
 * 레이어 수가 안 맞을 때:
 *  · 줄이 더 많으면 → 남는 줄을 **마지막 레이어에 줄바꿈으로 합친다**(버리지 않는다).
 *  · 레이어가 더 많으면 → 남는 레이어를 **빈 문자열**로 만든다(옛 문구가 남으면 안 된다).
 */
export function patchTitleMogrt(
  base: Uint8Array, layers: MogrtTextLayer[], meta: MogrtMeta,
  opts: { stripThumbs?: boolean; image?: Uint8Array | null } = {},
): Uint8Array {
  if (!layers.length) throw new Error("layers is empty");
  const outer = unzipSync(base);
  const defRaw = outer["definition.json"];
  if (!outer["project.prgraphic"] || !defRaw) {
    throw new Error("not a .mogrt (definition.json / project.prgraphic 없음)");
  }

  // ⚠️ **로케일 판을 전부 같이 고친다.** Adobe 기본 템플릿에는 `project.prgraphic` 말고
  //    `project_ko_KR.prgraphic` 같은 언어별 판이 들어 있고, **프리미어는 자기 UI 언어의 판을
  //    먼저 읽는다.** 기본판만 고치면 한국어 프리미어에는 옛 문구가 뜬다.
  //    (2026-09-01 1차 시도로 로케일 판을 **지웠더니** 그래픽이 통째로 비어서 떴다 —
  //     한국어 프리미어는 없는 판을 기본판으로 대체하지 않는다. 지우지 말고 고칠 것.)
  let patched = 0;
  for (const name of Object.keys(outer)) {
    if (!name.endsWith(".prgraphic")) continue;
    if (patchGraphic(outer, name, layers, opts.image)) patched += 1;
  }
  if (!patched) throw new Error("텍스트 레이어를 찾지 못했다 — 베이스 템플릿이 제목용이 아니다");

  // ── ④ 겉이름·id. **id 를 안 바꾸면** 프리미어가 앞서 넣은 템플릿과 같은 것으로 보고
  //     캐시를 써서, 두 번째 제목이 첫 번째 문구로 뜬다.
  const def = JSON.parse(Buffer.from(defRaw).toString("utf-8"));
  def.capsuleID = meta.capsuleId;
  def.capsuleName = meta.capsuleName;
  if (def.capsuleNameLocalized?.strDB) {
    for (const s of def.capsuleNameLocalized.strDB) s.str = meta.capsuleName;
  }
  // 노출 컨트롤(필수 그래픽 패널)의 기본 문구도 맞춘다 — 안 맞추면 패널에는 옛 문구가 보인다.
  let ctlIdx = 0;
  for (const ctl of def.clientControls ?? []) {
    if (ctl?.type !== 6) continue;
    const layer = layers[ctlIdx++];
    if (ctl.value?.strDB) for (const s of ctl.value.strDB) s.str = layer ? layer.text : "";
  }
  outer["definition.json"] = new Uint8Array(Buffer.from(JSON.stringify(def), "utf-8"));

  // 미리보기 썸네일(thumb*.png/mp4)은 **파일 크기의 대부분**이다(622KB 중 ~600KB). 자막처럼
  // 수십 장을 찍어 내릴 때는 빼서 30KB 안팎으로 만든다 — 목록 아이콘이 비는 대신 전송이 20배 싸다.
  // 제목처럼 한 장만 쓸 때는 남긴다(필수 그래픽 목록에서 눈으로 찾기 쉽다).
  if (opts.stripThumbs) {
    for (const name of Object.keys(outer)) {
      if (/^thumb/i.test(name)) delete outer[name];
    }
  }

  return zipSync(outer);
}

/** 베이스로 쓸 수 있는 파일인지 — 텍스트 레이어가 하나라도 있어야 한다. */
export function inspectMogrt(base: Uint8Array): { textLayers: number; capsuleName: string } {
  const outer = unzipSync(base);
  const defRaw = outer["definition.json"];
  const graphic = outer["project.prgraphic"];
  if (!defRaw || !graphic) throw new Error("not a .mogrt (definition.json / project.prgraphic 없음)");
  const def = JSON.parse(Buffer.from(defRaw).toString("utf-8"));
  const inner = unzipSync(graphic);
  const prName = Object.keys(inner).find((n) => n.endsWith(".prproj"));
  if (!prName) throw new Error(".prgraphic 안에 .prproj 가 없다");
  const xml = Buffer.from(gunzipSync(Buffer.from(inner[prName]))).toString("utf-8");
  let count = 0;
  for (const m of xml.matchAll(TEXT_BLOB_RE)) if (decodeTextBlob(m[2])) count += 1;
  return { textLayers: count, capsuleName: String(def.capsuleName ?? "") };
}

/** #rrggbb → 0xRRGGBB. 못 읽으면 흰색. */
export function colorToInt(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex ?? "").trim());
  return m ? parseInt(m[1], 16) : 0xffffff;
}

/**
 * 우리 아이템 align → 프리미어 `mAlignment`.
 *
 * **0=왼쪽 · 1=오른쪽 · 2=가운데.** 흔한 순서(왼·가운데·오른)가 아니다 — 애프터이펙트
 * `ParagraphJustification` 과 같은 순서다(LEFT·RIGHT·CENTER). 텍스트 엔진이 같다.
 *
 * 어떻게 알았나(2026-09-01): 가운데를 1 로 넣었더니 제목 두 줄이 화면 가운데에서 **왼쪽으로**
 * 뻗었다. 글자 끝이 x=0.5 에 정확히 붙어 있었으니 가운데가 아니라 **오른쪽 정렬**이었다.
 */
export function alignToMogrt(align: string | undefined): 0 | 1 | 2 {
  return align === "center" ? 2 : align === "right" ? 1 : 0;
}

/**
 * 글자 상단(우리 좌표) → 글자 기준선(프리미어 좌표) 보정 비율.
 *
 * 우리 아이템의 y 는 **글자 상단**(baseline:"top")인데, 프리미어 텍스트 레이어의 Position 은
 * **기준선**이다. em 대비 상단→기준선 거리는 글꼴마다 다르지만 0.8 근처다 — 정확한 값은
 * 폰트의 hhea/OS2 를 읽어야 하고, 그렇게까지 해도 프리미어의 앵커 규칙과 완전히 같지는 않다.
 * 그래서 **근사치 한 개**로 두고, 어긋나면 여기 하나만 고친다(2026-08-31 눈으로 보정).
 */
export const TOP_TO_BASELINE = 0.8;

/** 서버 오버레이 아이템(출력 px 좌표) → mogrt 레이어(0..1 좌표). PNG 경로와 **같은 입력**이다. */
export function layersFromOverlayItems(
  items: Array<{
    text: string; x: number; y: number; align?: string; baseline?: string;
    fontPx: number; weight?: number; font?: string; color: string;
  }>,
  W: number, H: number,
  postScriptNameOf: (font: string | undefined, weight: number) => string | null,
): MogrtTextLayer[] {
  return items.map((it) => {
    const fontPx = Math.max(1, Number(it.fontPx) || 1);
    // baseline 이 "top" 이면 기준선까지 내려 주고, "middle"·"alphabetic" 은 그대로 쓴다.
    const yPx = it.baseline === "middle" || it.baseline === "alphabetic"
      ? Number(it.y) : Number(it.y) + fontPx * TOP_TO_BASELINE;
    return {
      text: String(it.text ?? ""),
      postScriptName: postScriptNameOf(it.font, Number(it.weight) || 800) ?? "",
      fontPx,
      colorInt: colorToInt(it.color),
      xNorm: clamp01(Number(it.x) / W),
      yNorm: clamp01(yPx / H),
      alignment: alignToMogrt(it.align),
    };
  });
}

function clamp01(v: number): number {
  return !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}
