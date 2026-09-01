/**
 * .mogrt 서버 생성 — 구조를 손대는 코드라 **왕복이 깨지지 않는지**를 고정한다.
 *
 * 왜 합성 픽스처인가: 진짜 베이스 템플릿은 Adobe 가 프리미어와 함께 깔아 주는 파일이라
 * 리포에 없다(있어서도 안 된다 — infra 재배포). 그래서 **같은 구조**를 테스트가 직접 만든다:
 *   zip{ definition.json, project.prgraphic = zip{ x.prproj = gzip(XML) } }
 * 이 구조 가정이 깨지면(프리미어가 포맷을 바꾸면) 여기가 아니라 실제 파일에서 터지므로,
 * 실물 확인은 사람이 한 번 하고(2026-08-31 완료) 여기서는 **우리 코드의 계약**만 지킨다.
 */
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { unzipSync, zipSync } from "fflate";

import {
  patchTitleMogrt, inspectMogrt, colorToInt, alignToMogrt,
  layersFromOverlayItems, TOP_TO_BASELINE, type MogrtTextLayer,
} from "../media/mogrt.ts";

// ── 합성 베이스 템플릿 ────────────────────────────────────────────────────────
function textBlob(text: string, font: string, size: number, color: number): string {
  const value = {
    mTextParam: {
      mAlignment: 2,
      mStyleSheet: {
        mText: text,
        mFontName: { mParamValues: [[0, font]] },
        mFontSize: { mParamValues: [[0, size]] },
        mFillColor: { mParamValues: [[0, color]] },
        mFillOverStroke: { mParamValues: [[0, false]] },
        mStrokeVisible: { mParamValues: [[0, false]] },
        mStrokeColor: { mParamValues: [[0, 0xffffff]] },
        mStrokeWidth: { mParamValues: [[0, 1]] },
      },
    },
    mVersion: 1,
  };
  const json = Buffer.from(JSON.stringify(value), "utf16le");
  const head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([head, json]).toString("base64");
}

/**
 * 로케일 판은 **`<Name>` 이 번역돼 있다** (실측: `Position`→`위치`, `Anchor Point`→`기준점`).
 * 언어와 무관한 열쇠는 `<ParameterID>` 뿐이라(위치=3·기준점=9), 픽스처도 그렇게 만든다 —
 * 안 그러면 "영어 이름으로 찾는" 회귀를 테스트가 못 잡는다.
 */
const NAMES = {
  en: { text: "Source Text", pos: "Position", anchor: "Anchor Point" },
  ko: { text: "소스 텍스트", pos: "위치", anchor: "기준점" },
};

function fakeXml(layers: number, loc: keyof typeof NAMES = "en"): string {
  const n = NAMES[loc];
  let xml = '<?xml version="1.0" encoding="UTF-8" ?>\n<PremiereData Version="3">\n';
  for (let i = 0; i < layers; i++) {
    xml += `\t<VideoComponentParam ObjectID="${100 + i}">\n`
      + `\t\t<Name>${n.text}</Name>\n`
      + `\t\t<StartKeyframeValue Encoding="base64" BinaryHash="deadbeef-0000-0000-0000-00000000000${i}">`
      + textBlob(`원래 ${i + 1}행`, "MyriadPro-Regular", 100, 0xffffff)
      + `</StartKeyframeValue>\n\t</VideoComponentParam>\n`
      + `\t<PointComponentParam ObjectID="${200 + i}" ClassID="ca81d347-309b-44d2-acc7-1c572efb973c">\n`
      + `\t\t<Name>${n.pos}</Name>\n`
      + `\t\t<IsTimeVarying>false</IsTimeVarying>\n`
      + `\t\t<StartKeyframe>-91445760000000000,0.5,0.888888,0,0,0,0,0,0,5,4,0,0,0,0</StartKeyframe>\n`
      + `\t\t<ParameterID>3</ParameterID>\n`
      + `\t</PointComponentParam>\n`
      // 기준점도 같은 PointComponentParam 이다 — 이걸 위치로 착각하면 글자가 엉뚱한 데로 간다.
      + `\t<PointComponentParam ObjectID="${300 + i}" ClassID="ca81d347-309b-44d2-acc7-1c572efb973c">\n`
      + `\t\t<Name>${n.anchor}</Name>\n`
      + `\t\t<StartKeyframe>-91445760000000000,0.777777,0.666666,0,0,0,0,0,0,5,4,0,0,0,0</StartKeyframe>\n`
      + `\t\t<ParameterID>9</ParameterID>\n`
      + `\t</PointComponentParam>\n`;
  }
  return xml + "</PremiereData>\n";
}

function fakeMogrt(layers = 2): Uint8Array {
  const graphic = (loc: keyof typeof NAMES) =>
    zipSync({ "PPro_Fake.prproj": new Uint8Array(gzipSync(Buffer.from(fakeXml(layers, loc), "utf-8"))) });
  const inner = graphic("en");
  const def = {
    capsuleID: "00000000-0000-0000-0000-000000000000",
    capsuleName: "Fake Base",
    capsuleNameLocalized: { strDB: [{ localeString: "en_US", str: "Fake Base" }] },
    clientControls: Array.from({ length: layers }, (_, i) => ({
      type: 6, id: String(i),
      value: { strDB: [{ localeString: "en_US", str: `원래 ${i + 1}행` }] },
    })),
  };
  return zipSync({
    "definition.json": new Uint8Array(Buffer.from(JSON.stringify(def), "utf-8")),
    "project.prgraphic": inner,
    // Adobe 기본 템플릿에는 로케일 판이 함께 들어 있다 — 프리미어는 자기 UI 언어 판을 먼저 읽는다.
    "project_ko_KR.prgraphic": graphic("ko"),
    "thumb.png": new Uint8Array([1, 2, 3]),
  });
}

/** 결과 .mogrt 를 도로 뜯어 본다 — 우리가 넣은 값이 실제로 파일에 있나. */
function readBack(bytes: Uint8Array, entry = "project.prgraphic"): { xml: string; def: any; names: string[] } {
  const outer = unzipSync(bytes);
  const inner = unzipSync(outer[entry]);
  const pr = Object.keys(inner).find((n) => n.endsWith(".prproj"))!;
  return {
    xml: Buffer.from(gunzipSync(Buffer.from(inner[pr]))).toString("utf-8"),
    def: JSON.parse(Buffer.from(outer["definition.json"]).toString("utf-8")),
    names: Object.keys(outer),
  };
}

function decodeBlobs(xml: string): any[] {
  const out: any[] = [];
  for (const m of xml.matchAll(/<StartKeyframeValue Encoding="base64"[^>]*>([A-Za-z0-9+/=\s]+)<\/StartKeyframeValue>/g)) {
    const raw = Buffer.from(m[1].replace(/\s/g, ""), "base64");
    const len = Number(raw.readBigUInt64LE(0));
    out.push(JSON.parse(raw.subarray(8, 8 + len).toString("utf16le")));
  }
  return out;
}

const layer = (over: Partial<MogrtTextLayer> = {}): MogrtTextLayer => ({
  text: "제목 한 줄", postScriptName: "GmarketSansTTFBold", fontPx: 96,
  colorInt: 0xf3af4f, xNorm: 0.5, yNorm: 0.12, alignment: 1, ...over,
});

const META = { capsuleId: "11111111-2222-3333-4444-555555555555", capsuleName: "[STEP-D] 제목" };

describe("mogrt — 베이스 판별", () => {
  it("텍스트 레이어 수를 센다 — 없으면 제목을 넣을 자리가 없다", () => {
    assert.equal(inspectMogrt(fakeMogrt(2)).textLayers, 2);
    assert.equal(inspectMogrt(fakeMogrt(1)).textLayers, 1);
  });

  it("mogrt 가 아니면 던진다 — 받아 두면 나중에 조용히 실패한다", () => {
    assert.throws(() => inspectMogrt(zipSync({ "hello.txt": new Uint8Array([1]) })), /not a \.mogrt/);
  });
});

describe("mogrt — 제목 채우기", () => {
  it("문구·글꼴·크기·색을 레이어마다 바꾼다", () => {
    const out = patchTitleMogrt(fakeMogrt(2), [
      layer({ text: "1행입니다", colorInt: 0xffffff, fontPx: 96 }),
      layer({ text: "2행입니다", colorInt: 0xf3af4f, fontPx: 88 }),
    ], META);
    const blobs = decodeBlobs(readBack(out).xml);
    assert.equal(blobs[0].mTextParam.mStyleSheet.mText, "1행입니다");
    assert.equal(blobs[1].mTextParam.mStyleSheet.mText, "2행입니다");
    assert.equal(blobs[0].mTextParam.mStyleSheet.mFontName.mParamValues[0][1], "GmarketSansTTFBold");
    assert.equal(blobs[1].mTextParam.mStyleSheet.mFontSize.mParamValues[0][1], 88);
    assert.equal(blobs[1].mTextParam.mStyleSheet.mFillColor.mParamValues[0][1], 0xf3af4f);
  });

  it("위치는 0..1 정규화 좌표로 들어간다", () => {
    const out = patchTitleMogrt(fakeMogrt(2), [
      layer({ xNorm: 0.5, yNorm: 0.11 }),
      layer({ xNorm: 0.25, yNorm: 0.2 }),
    ], META);
    const { xml } = readBack(out);
    assert.ok(xml.includes(",0.5,0.11,"), "1행 위치가 안 들어갔다");
    assert.ok(xml.includes(",0.25,0.2,"), "2행 위치가 안 들어갔다");
    assert.ok(!xml.includes("0.888888"), "원본 위치가 남아 있다");
  });

  it("글꼴 이름이 비면 **건드리지 않는다** — 빈 값이면 프리미어가 글꼴을 못 찾는다", () => {
    const out = patchTitleMogrt(fakeMogrt(1), [layer({ postScriptName: "" })], META);
    const blobs = decodeBlobs(readBack(out).xml);
    assert.equal(blobs[0].mTextParam.mStyleSheet.mFontName.mParamValues[0][1], "MyriadPro-Regular");
  });

  it("캡슐 id 는 **요청마다 다르다** — 같으면 프리미어가 첫 제목을 캐시해서 재사용한다", () => {
    const def = readBack(patchTitleMogrt(fakeMogrt(2), [layer()], META)).def;
    assert.equal(def.capsuleID, META.capsuleId);
    assert.equal(def.capsuleName, META.capsuleName);
    assert.equal(def.capsuleNameLocalized.strDB[0].str, META.capsuleName);
  });

  it("노출 컨트롤 기본 문구도 맞춘다 — 안 맞추면 필수 그래픽 패널에 옛 문구가 뜬다", () => {
    const def = readBack(patchTitleMogrt(fakeMogrt(2), [layer({ text: "가" }), layer({ text: "나" })], META)).def;
    assert.equal(def.clientControls[0].value.strDB[0].str, "가");
    assert.equal(def.clientControls[1].value.strDB[0].str, "나");
  });

  it("레이어가 남으면 **비운다** — 옛 문구가 화면에 남으면 안 된다", () => {
    const out = patchTitleMogrt(fakeMogrt(2), [layer({ text: "한 줄만" })], META);
    const blobs = decodeBlobs(readBack(out).xml);
    assert.equal(blobs[0].mTextParam.mStyleSheet.mText, "한 줄만");
    assert.equal(blobs[1].mTextParam.mStyleSheet.mText, "");
  });

  it("줄이 더 많으면 마지막 레이어에 **합친다** — 버리지 않는다", () => {
    const out = patchTitleMogrt(fakeMogrt(2), [
      layer({ text: "1행" }), layer({ text: "2행" }), layer({ text: "3행" }),
    ], META);
    const blobs = decodeBlobs(readBack(out).xml);
    assert.equal(blobs[0].mTextParam.mStyleSheet.mText, "1행");
    assert.equal(blobs[1].mTextParam.mStyleSheet.mText, "2행\r3행");
  });

  it("**언어별 그래픽 변형도 같이 고친다** — 한국어 프리미어는 ko_KR 판을 읽는다", () => {
    // 2026-09-01 두 번 데었다. ① 기본판만 고쳤더니 한국어 프리미어에 옛 문구가 떴고,
    // ② 로케일 판을 **지웠더니** 그래픽이 통째로 비어서 떴다(기본판으로 안 떨어진다).
    // 정답은 지우는 것도 하나만 고치는 것도 아니고 **전부 고치는 것**이다.
    const out = patchTitleMogrt(fakeMogrt(2), [layer({ text: "가" }), layer({ text: "나" })], META);
    const back = readBack(out, "project_ko_KR.prgraphic");
    assert.ok(back.names.includes("project_ko_KR.prgraphic"), "로케일 판을 지우면 그래픽이 빈다");
    const blobs = decodeBlobs(back.xml);
    assert.equal(blobs[0].mTextParam.mStyleSheet.mText, "가", "ko_KR 판에 우리 글자가 없다");
    assert.equal(blobs[1].mTextParam.mStyleSheet.mText, "나");
  });

  it("로케일 판의 **위치**도 들어간다 — `<Name>` 이 번역돼 있어 이름으로 찾으면 못 찾는다", () => {
    const out = patchTitleMogrt(fakeMogrt(2), [
      layer({ xNorm: 0.5, yNorm: 0.11 }), layer({ xNorm: 0.25, yNorm: 0.2 }),
    ], META);
    const { xml } = readBack(out, "project_ko_KR.prgraphic");
    assert.ok(xml.includes(",0.5,0.11,"), "ko_KR 판 위치가 안 들어갔다");
    assert.ok(!xml.includes("0.888888"), "ko_KR 판에 원본 위치가 남아 있다");
  });

  it("**기준점은 건드리지 않는다** — 같은 PointComponentParam 이라 착각하기 쉽다", () => {
    const out = patchTitleMogrt(fakeMogrt(2), [layer({ xNorm: 0.5, yNorm: 0.11 })], META);
    for (const entry of ["project.prgraphic", "project_ko_KR.prgraphic"]) {
      const { xml } = readBack(out, entry);
      assert.equal((xml.match(/,0\.777777,0\.666666,/g) || []).length, 2,
        `${entry}: 기준점이 위치로 덮어써졌다`);
    }
  });

  it("썸네일 등 나머지 항목은 그대로 남는다 — 통째로 새로 만들지 않는다", () => {
    const back = readBack(patchTitleMogrt(fakeMogrt(2), [layer()], META));
    assert.ok(back.names.includes("thumb.png"));
  });

  it("레이어가 없으면 던진다", () => {
    assert.throws(() => patchTitleMogrt(fakeMogrt(2), [], META), /layers is empty/);
  });
});

describe("mogrt — 자막용 옵션", () => {
  it("썸네일을 떼면 파일이 확 줄어든다 — 자막은 수십 장을 내린다", () => {
    const full = patchTitleMogrt(fakeMogrt(1), [layer()], META);
    const slim = patchTitleMogrt(fakeMogrt(1), [layer()], META, { stripThumbs: true });
    assert.ok(readBack(full).names.includes("thumb.png"));
    assert.ok(!readBack(slim).names.includes("thumb.png"), "썸네일이 남아 있다");
    assert.ok(slim.length < full.length, "줄지 않았다");
  });

  it("외곽선을 옮긴다 — 자막의 검정 스트로크가 빠지면 배경에 묻힌다", () => {
    const out = patchTitleMogrt(fakeMogrt(1), [layer({ stroke: { colorInt: 0x000000, width: 4 } })], META);
    const ss = decodeBlobs(readBack(out).xml)[0].mTextParam.mStyleSheet;
    assert.equal(ss.mStrokeVisible.mParamValues[0][1], true);
    assert.equal(ss.mStrokeWidth.mParamValues[0][1], 4);
    assert.equal(ss.mFillOverStroke.mParamValues[0][1], true, "칠이 선 뒤면 글자가 얇아 보인다");
  });

  it("stroke 를 안 주면 템플릿 값을 그대로 둔다", () => {
    const out = patchTitleMogrt(fakeMogrt(1), [layer()], META);
    const ss = decodeBlobs(readBack(out).xml)[0].mTextParam.mStyleSheet;
    assert.equal(ss.mStrokeVisible.mParamValues[0][1], false);
  });
});

describe("mogrt — 오버레이 아이템 → 레이어", () => {
  const ps = (font: string | undefined) => (font === "gmarket" ? "GmarketSansTTFBold" : null);

  it("PNG 와 **같은 입력**을 받는다 — 좌표는 출력 px, 결과는 0..1", () => {
    const [l] = layersFromOverlayItems(
      [{ text: "훅", x: 540, y: 200, align: "center", baseline: "top", fontPx: 100, weight: 700, font: "gmarket", color: "#F3AF4F" }],
      1080, 1920, ps,
    );
    assert.equal(l.xNorm, 0.5);
    assert.equal(l.yNorm, (200 + 100 * TOP_TO_BASELINE) / 1920);
    assert.equal(l.alignment, 2, "가운데는 2 다 — 1 은 오른쪽 정렬이라 글자가 왼쪽으로 뻗는다");
    assert.equal(l.colorInt, 0xf3af4f);
    assert.equal(l.postScriptName, "GmarketSansTTFBold");
  });

  it("baseline 이 top 이 아니면 보정하지 않는다 — 이미 기준선이다", () => {
    const [l] = layersFromOverlayItems(
      [{ text: "훅", x: 0, y: 300, align: "left", baseline: "middle", fontPx: 80, color: "#fff" }],
      1080, 1920, ps,
    );
    assert.equal(l.yNorm, 300 / 1920);
  });

  it("폰트 파일을 못 읽으면 빈 이름 — 템플릿 글꼴을 유지시킨다", () => {
    const [l] = layersFromOverlayItems(
      [{ text: "훅", x: 0, y: 0, align: "left", fontPx: 80, font: "없는패밀리", color: "#fff" }],
      1080, 1920, ps,
    );
    assert.equal(l.postScriptName, "");
  });

  it("화면 밖 좌표는 0..1 로 잘린다 — 프리미어가 이상한 위치로 튀지 않게", () => {
    const [l] = layersFromOverlayItems(
      [{ text: "훅", x: -50, y: 99999, align: "left", fontPx: 80, color: "#fff" }],
      1080, 1920, ps,
    );
    assert.equal(l.xNorm, 0);
    assert.equal(l.yNorm, 1);
  });
});

describe("mogrt — 색·정렬 변환", () => {
  it("#rrggbb → 정수, 못 읽으면 흰색", () => {
    assert.equal(colorToInt("#F3AF4F"), 0xf3af4f);
    assert.equal(colorToInt("f3af4f"), 0xf3af4f);
    assert.equal(colorToInt("빨강"), 0xffffff);
  });

  it("align → mAlignment (0 왼쪽 · **1 오른쪽** · 2 가운데)", () => {
    // ⚠️ 흔한 순서가 아니다. 애프터이펙트 ParagraphJustification(LEFT·RIGHT·CENTER)과 같다.
    // 2026-09-01 실측: 가운데를 1 로 넣었더니 글자 끝이 x=0.5 에 붙었다(=오른쪽 정렬).
    assert.equal(alignToMogrt("left"), 0);
    assert.equal(alignToMogrt("right"), 1);
    assert.equal(alignToMogrt("center"), 2);
    assert.equal(alignToMogrt(undefined), 0);
  });
});
