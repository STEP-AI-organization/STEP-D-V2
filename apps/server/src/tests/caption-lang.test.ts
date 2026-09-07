/**
 * 다국어 자막·메타 (2026-09-07 · 1차 베트남어).
 *
 * 이 기능의 실패 모드는 **조용하다.** libass 는 글리프가 없어도 오류를 안 내고 다른 폰트로
 * 대체하고, 번역이 없으면 한국어가 그대로 나가며, 게이트가 새면 안 시킨 번역이 돈다.
 * 셋 다 발행되고 나서야 안다 — 그래서 여기서 실측을 고정한다.
 *
 * 특히 §"허용 글꼴" 은 **폰트 파일의 cmap 을 실제로 읽는다.** 목록을 손으로 적어두면
 * 폰트를 갈아끼웠을 때 아무도 모른다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CAPTION_LANGS, DEFAULT_LANG, isForeign, langOf, snapFont,
} from "../media/caption-lang.ts";
import { clipCues, toWebVtt } from "../media/caption-vtt.ts";
import { captionMaxCharsOf, CAPTION_CHUNK_MAX_CHARS } from "../media/caption-chunk.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");

// ── 폰트 커버리지 (cmap 실측) ──────────────────────────────────────────────────

/** sfnt 테이블 오프셋 (.ttf/.otf 공통). */
function tableOffset(d: Buffer, tag: string): number {
  const n = d.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    if (d.toString("latin1", r, r + 4) === tag) return d.readUInt32BE(r + 8);
  }
  return -1;
}

/** cmap(format 4/12)에서 이 폰트가 그릴 수 있는 코드포인트 집합. */
function coverage(d: Buffer): Set<number> {
  const cmap = tableOffset(d, "cmap");
  assert.ok(cmap >= 0, "cmap 테이블이 없다 — 폰트 파일이 깨졌다");
  const n = d.readUInt16BE(cmap + 2);
  let best = -1, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const r = cmap + 4 + i * 8;
    const pid = d.readUInt16BE(r), eid = d.readUInt16BE(r + 2);
    const score = pid === 3 && eid === 10 ? 3 : pid === 3 && eid === 1 ? 2 : pid === 0 ? 1 : 0;
    if (score > bestScore) { bestScore = score; best = cmap + d.readUInt32BE(r + 4); }
  }
  const set = new Set<number>();
  const fmt = d.readUInt16BE(best);
  if (fmt === 4) {
    const segX2 = d.readUInt16BE(best + 6), seg = segX2 / 2;
    const endO = best + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let s = 0; s < seg; s++) {
      const end = d.readUInt16BE(endO + s * 2), start = d.readUInt16BE(startO + s * 2);
      const delta = d.readInt16BE(deltaO + s * 2), ro = d.readUInt16BE(rangeO + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let g: number;
        if (ro === 0) g = (c + delta) & 0xffff;
        else {
          const gi = rangeO + s * 2 + ro + (c - start) * 2;
          if (gi + 1 >= d.length) continue;
          g = d.readUInt16BE(gi);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g !== 0) set.add(c);
      }
    }
  } else if (fmt === 12) {
    const groups = d.readUInt32BE(best + 12);
    for (let i = 0; i < groups; i++) {
      const g = best + 16 + i * 12;
      const s = d.readUInt32BE(g), e = d.readUInt32BE(g + 4);
      for (let c = s; c <= e && c - s < 70000; c++) set.add(c);
    }
  }
  return set;
}

/** 그 언어가 실제로 쓰는 문자 전부. */
function charsFor(code: string): number[] {
  if (code !== "vi") return [];
  const out: number[] = [];
  for (const ch of "ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯư") out.push(ch.codePointAt(0)!);
  for (let c = 0x1ea0; c <= 0x1ef9; c++) out.push(c);   // Latin Extended Additional (베트남어 전용)
  return out;
}

/** 카탈로그 글꼴 id → 실제 파일. `ASS_FONT_BY_ID`(index.ts)와 같은 축이다. */
const FONT_FILES: Record<string, string> = {
  pretendard: "assets/fonts/Pretendard-ExtraBold.otf",
  gothica1: "assets/fonts/GothicA1-Black.ttf",
};

describe("다국어 — 허용 글꼴이 그 언어를 실제로 덮는가 (cmap 실측)", () => {
  for (const [code, lang] of Object.entries(CAPTION_LANGS)) {
    if (!lang.allowFonts.length) continue;
    const chars = charsFor(code);
    if (!chars.length) continue;

    for (const id of lang.allowFonts) {
      it(`${lang.nameKo} · ${id} 가 ${chars.length}자를 전부 그린다`, () => {
        const file = FONT_FILES[id];
        assert.ok(file, `${id} 의 폰트 파일 경로를 모른다 — FONT_FILES 에 추가할 것`);
        const cov = coverage(fs.readFileSync(path.join(ROOT, file)));
        const missing = chars.filter((c) => !cov.has(c));
        assert.equal(missing.length, 0,
          `${id}(${file}) 가 ${lang.nameKo} 문자 ${missing.length}자를 못 그린다: ` +
          missing.slice(0, 10).map((c) => String.fromCodePoint(c)).join(" ") +
          " — libass 는 오류 없이 다른 폰트로 대체하므로 발행 전엔 아무도 모른다");
      });
    }
  }

  it("썸네일 대체표가 가리키는 폰트도 베트남어를 덮는다 (Pillow 는 폴백을 안 한다)", (t) => {
    const py = read("core/thumbnail/caption_overlay.py");
    const block = py.slice(py.indexOf("LANG_FONT_FALLBACK"), py.indexOf("def _font_for"));
    // 베트남어를 0% 덮는 폰트(cmap 실측)는 **전부** 대체표에 있어야 한다.
    // 개수를 세는 것보다 이게 정확한 불변식이다 — 하나라도 빠지면 그 프리셋만 두부가 된다.
    for (const bad of ["BlackHanSans-Regular.ttf", "Jua-Regular.ttf", "DoHyeon-Regular.ttf", "Gugi-Regular.ttf"]) {
      assert.ok(block.includes(`"${bad}"`),
        `${bad} 가 베트남어 대체표에 없다 — 이 폰트는 베트남어를 0% 덮어 두부(□)가 찍힌다`);
    }
    const targets = [...new Set([...block.matchAll(/:\s*"([\w-]+\.(?:ttf|otf))"/g)].map((m) => m[1]))];
    assert.ok(targets.length > 0, "대체 대상 폰트를 못 찾았다 — 대체표 형식이 바뀌었나");

    // ⚠️ 썸네일 폰트는 **일부러 gitignore 돼 있다**(61MB · .gitignore:25). 로컬에서
    // `scripts/ops/download-fonts.ps1` 로 받는 구조라 CI 체크아웃에는 파일이 없다.
    // 그래서 파일이 있을 때만 cmap 을 검사한다 — 없다고 CI 를 빨갛게 만들면
    // 사람이 관문 전체를 무시하게 된다(CLAUDE.md 원칙).
    //
    // 대신 **이름이 목록에 있는지는 항상 검사한다.** 오타나 없는 파일명을 대체표에 적으면
    // Pillow 가 두부(□)를 그리는데, 그건 폰트가 깔린 환경에서도 안 잡히는 종류의 실수다.
    const readme = read("assets/thumbnail/fonts/README.md");
    for (const f of targets) {
      assert.ok(readme.includes(f),
        `대체 폰트 ${f} 가 assets/thumbnail/fonts/README.md 의 다운로드 목록에 없다 — ` +
        "받아지지 않는 파일을 가리키면 Pillow 가 두부(□)를 그린다");
    }

    const present = targets.filter((f) => fs.existsSync(path.join(ROOT, "assets/thumbnail/fonts", f)));
    if (present.length === 0) {
      t.skip("썸네일 폰트가 로컬에 없다 (gitignore · download-fonts.ps1 로 받는다) — cmap 검사 생략");
      return;
    }
    const chars = charsFor("vi");
    for (const f of present) {
      const cov = coverage(fs.readFileSync(path.join(ROOT, "assets/thumbnail/fonts", f)));
      const missing = chars.filter((c) => !cov.has(c));
      assert.equal(missing.length, 0, `썸네일 대체 폰트 ${f} 가 베트남어 ${missing.length}자를 못 그린다 — 두부(□)가 찍힌다`);
    }
  });
});

// ── 언어 해석 · 스냅 ───────────────────────────────────────────────────────────

describe("다국어 — 언어 해석은 모르는 값을 조용히 한국어로 떨어뜨린다", () => {
  it("빈값·오타·null 이 전부 한국어", () => {
    for (const v of [undefined, null, "", "  ", "vn", "VI-VN-x", "ko-KR", "zz"]) {
      assert.equal(langOf(v as any).code, "ko", `${JSON.stringify(v)} 가 한국어로 안 떨어진다`);
    }
    // 실패 모드가 "한국어로 나감"이지 "깨진 자막으로 나감"이 아니어야 한다.
    assert.equal(isForeign(langOf("vn")), false);
  });

  it("정상 코드는 대소문자·공백을 흡수한다", () => {
    for (const v of ["vi", "VI", " vi ", "Vi"]) assert.equal(langOf(v).code, "vi");
    assert.equal(isForeign(langOf("vi")), true);
  });

  it("한국어는 글꼴을 제한하지 않는다 — 기존 동작 무회귀", () => {
    for (const id of ["gmarket", "blackhansans", "jua", "", "이상한값"]) {
      assert.equal(snapFont(id, DEFAULT_LANG), id, "한국어에서 글꼴이 바뀌면 기존 렌더가 달라진다");
    }
  });

  it("베트남어는 못 덮는 글꼴을 갈아끼우고, 덮는 건 그대로 둔다", () => {
    const vi = langOf("vi");
    for (const bad of ["gmarket", "blackhansans", "jua", "dohyeon", "", "오타"]) {
      assert.equal(snapFont(bad, vi), "pretendard", `${bad} 가 스냅되지 않는다 — 제목이 조용히 깨진다`);
    }
    assert.equal(snapFont("gothica1", vi), "gothica1", "덮는 글꼴까지 갈아끼우면 사용자 선택을 무시하는 것");
    assert.equal(snapFont("pretendard", vi), "pretendard");
  });
});

// ── 한 화면 글자수 ─────────────────────────────────────────────────────────────

describe("다국어 — 한 화면 글자수는 언어 폭을 따른다", () => {
  it("언어 미지정이면 종전 상수 그대로 (무회귀)", () => {
    assert.equal(captionMaxCharsOf(undefined), CAPTION_CHUNK_MAX_CHARS);
    assert.equal(captionMaxCharsOf({}), CAPTION_CHUNK_MAX_CHARS);
    assert.equal(captionMaxCharsOf({ lang: "ko" }), CAPTION_CHUNK_MAX_CHARS);
  });

  it("베트남어는 같은 표시폭이 되도록 더 많은 글자를 넣는다", () => {
    const ko = CAPTION_LANGS.ko, vi = CAPTION_LANGS.vi;
    assert.equal(captionMaxCharsOf({ lang: "vi" }), vi.captionMaxChars);
    assert.ok(vi.captionMaxChars > ko.captionMaxChars,
      "베트남어 글자가 한글보다 좁은데 상한이 같으면 화면 폭의 절반만 쓴다");
    // 두 언어의 **표시폭**이 10% 안에서 같아야 한다 — 이게 이 숫자들의 존재 이유다.
    const widthKo = ko.captionMaxChars * ko.widthEm;
    const widthVi = vi.captionMaxChars * vi.widthEm;
    assert.ok(Math.abs(widthKo - widthVi) / widthKo < 0.1,
      `한 줄 폭이 갈라졌다 — 한국어 ${widthKo.toFixed(1)}em vs 베트남어 ${widthVi.toFixed(1)}em`);
  });

  it("사용자 슬라이더 오버라이드가 언어 기본값을 이긴다", () => {
    assert.equal(captionMaxCharsOf({ lang: "vi", captionMaxChars: 9 }), 9);
    // 과소·오타는 종전대로 무시하고 언어 기본으로.
    assert.equal(captionMaxCharsOf({ lang: "vi", captionMaxChars: 2 }), CAPTION_LANGS.vi.captionMaxChars);
    assert.equal(captionMaxCharsOf({ lang: "vi", captionMaxChars: "많이" }), CAPTION_LANGS.vi.captionMaxChars);
  });
});

// ── WebVTT ────────────────────────────────────────────────────────────────────

describe("다국어 — 캡션 트랙(WebVTT)", () => {
  it("구간 자막을 0 기준으로 옮기고 문장은 자르지 않는다", () => {
    // 번인(windowCaptions)과 **일부러 다르다**: 트랙은 플레이어가 그리므로 잘린 문장이
    // 자막 메뉴에 남으면 그냥 오역처럼 보인다.
    const segs = [
      { start: 5, end: 8, text: "구간 앞 — 버려진다" },
      { start: 12, end: 14, text: "Chuyện này thật sự không thể tin nổi" },
      { start: 19, end: 24, text: "경계에 걸친 문장" },
      { start: 40, end: 42, text: "구간 뒤 — 버려진다" },
    ];
    const cues = clipCues(segs, 10, 20);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, 2);
    assert.equal(cues[0].end, 4);
    assert.equal(cues[1].text, "경계에 걸친 문장", "걸친 문장의 텍스트를 자르면 안 된다");
    assert.equal(cues[1].end, 10, "구간 밖으로 넘어간 시간은 클램프해야 한다");
  });

  it("VTT 헤더·타임스탬프 형식", () => {
    const vtt = toWebVtt([{ start: 0, end: 1.5, text: "Xin chào" }]);
    assert.match(vtt, /^WEBVTT\n/, "WEBVTT 헤더가 없으면 유튜브가 거부한다");
    assert.match(vtt, /00:00:00\.000 --> 00:00:01\.500/);
    assert.match(vtt, /Xin chào/);
  });

  it("한 시간을 넘는 타임스탬프도 시:분:초로 나온다", () => {
    const vtt = toWebVtt([{ start: 3725.25, end: 3726, text: "긴 회차" }]);
    assert.match(vtt, /01:02:05\.250 --> 01:02:06\.000/);
  });

  it("깨진 큐는 버린다 — 하나가 트랙 전체를 거부시키지 않게", () => {
    const vtt = toWebVtt([
      { start: 1, end: 0.5, text: "시간 역전" },
      { start: 2, end: 3, text: "   " },
      { start: NaN, end: 5, text: "숫자 아님" },
      { start: 6, end: 7, text: "정상" },
    ]);
    assert.equal((vtt.match(/-->/g) ?? []).length, 1);
    assert.match(vtt, /정상/);
  });

  it("겹치는 큐는 앞 큐를 당겨 붙인다 — 두 줄이 동시에 뜨지 않게", () => {
    const vtt = toWebVtt([
      { start: 0, end: 5, text: "앞" },
      { start: 3, end: 6, text: "뒤" },
    ]);
    assert.match(vtt, /00:00:00\.000 --> 00:00:03\.000/);
  });

  it("텍스트 안의 `-->` 는 큐를 갈라놓으므로 치환한다", () => {
    const vtt = toWebVtt([{ start: 0, end: 1, text: "가격 3000 --> 2000" }]);
    assert.equal((vtt.match(/-->/g) ?? []).length, 1, "본문의 화살표가 타임스탬프로 오인된다");
  });
});

// ── 게이트 · 원문 보존 (소스 스캔) ─────────────────────────────────────────────

describe("다국어 — 번역 게이트와 원문 보존", () => {
  const stages = read("core/analyze_stages.py");
  const translateOut = read("core/stt/translate_out.py");

  it("언어의 정본은 자동배포 계획이다 — env 스위치를 쓰지 않는다", () => {
    // 켜는 곳이 둘이면 반드시 한쪽만 켜지고 그 실패가 조용하다("번역만 쌓이고 안 쓰임"
    // 또는 "계획은 베트남어인데 한국어가 나감"). 계획이 곧 스위치면 그 어긋남이 성립 안 한다.
    const fn = stages.slice(stages.indexOf("def run_translate_out"), stages.indexOf("def run_fast_mode"));
    assert.doesNotMatch(fn, /os\.environ/, "번역이 다시 env 스위치로 갔다");
    assert.match(fn, /if not langs:\s*\n\s*return \{\}/,
      "빈 목록에서 즉시 반환하지 않으면 안 시킨 번역이 돈다 (회차마다 ₩20 × 언어)");

    const pipeline = read("apps/server/src/pipeline/content-pipeline.ts");
    assert.match(pipeline, /async function resolveTranslateLangs/,
      "서버가 계획에서 언어를 모으지 않으면 core 에 넘길 값이 없다");
    assert.match(pipeline, /if \(\(r as any\)\.enabled === false\) continue;/,
      "꺼진 계획까지 세면 안 돌 계획 때문에 회차마다 번역비를 쓴다");
    assert.match(pipeline, /args\.push\("--translate-langs"/);
  });

  it("모르는 언어 코드는 걸러진다 — 오타가 LLM 호출로 이어지지 않게", () => {
    const fn = stages.slice(stages.indexOf("def run_translate_out"), stages.indexOf("def run_fast_mode"));
    assert.match(fn, /if c in LANGS/,
      "모르는 코드를 안 거르면 오타가 그대로 LLM 호출로 간다");
  });

  it("나가는 번역은 원본 세그먼트를 mutate 하지 않는다", () => {
    // 한국어 자막은 계속 나가야 한다. 원본을 치환하면 국내 배포가 베트남어로 나간다.
    assert.match(translateOut, /seg = \{k: v for k, v in s\.items\(\) if k != "words"\}/,
      "입력을 복사하지 않으면 한국어 원본이 오염된다");
    assert.match(translateOut, /seg\["text_ko"\] = s\.get\("text"\)/, "원문 보존 필드가 없다");
  });

  it("번역 실패는 한국어 원문을 남긴다 — 자막이 사라지지 않게", () => {
    assert.match(translateOut, /if not t:\s*\n\s*continue\s+# 빈 번역·누락 → 한국어 원문 유지/);
  });

  it("자막 길이 제약이 프롬프트에 박혀 있다 — 한→베는 폭이 1.75배다", () => {
    assert.match(translateOut, /\[≤\{_max_chars\(text, lang\)\}자\]/,
      "줄마다 허용 글자수를 안 주면 9:16 에서 2줄이 3줄로 넘친다");
    assert.match(translateOut, /\[≤N자\] 를 반드시 지킨다/);
  });

  it("core 의 번역 길이 예산과 서버의 한 화면 글자수가 같은 값이다 (쌍둥이)", () => {
    // core 가 "≤N자" 로 번역을 묶고, 서버가 그 텍스트를 N자로 접는다. 갈라지면 둘 중 하나다:
    //  · core 예산 > 서버 폭 → 번역이 매번 2줄로 접힌다
    //  · core 예산 < 서버 폭 → 뜻을 깎아내고도 화면 폭이 남는다
    const langs = translateOut.slice(translateOut.indexOf("LANGS: dict"), translateOut.indexOf("_HANGUL_SYL"));
    for (const [code, lang] of Object.entries(CAPTION_LANGS)) {
      if (code === DEFAULT_LANG.code) continue;
      const m = langs.match(new RegExp(`"${code}": Lang\\([^)]*?([\\d.]+),\\s*(\\d+)\\)`));
      assert.ok(m, `core LANGS 에 ${code} 가 없다 — 서버만 알고 파이썬은 모르는 언어`);
      assert.equal(Number(m[1]), lang.widthEm, `${code} 글자 폭이 갈라졌다`);
      assert.equal(Number(m[2]), lang.captionMaxChars, `${code} 한 화면 글자수가 갈라졌다`);
    }
  });

  it("길이 예산 하한이 한 화면 글자수다 — 그보다 좁게 주면 모순", () => {
    assert.match(translateOut, /return max\(lang\.screen_chars, round\(_width_em\(text\) \/ lang\.width_em\)\)/,
      "하한이 상수면 짧은 줄에서 예산이 화면보다 좁아져 모델이 뜻을 깎고도 초과한다");
  });

  it("고유명사는 번역하지 않는다 — 검색이 그 이름으로 걸린다", () => {
    assert.match(translateOut, /번역하지 말고 원문 그대로/);
    const meta = read("apps/server/src/pipeline/clip-metadata.ts");
    assert.match(meta, /번역도 음차도/, "메타 쪽 고유명사 규칙이 빠졌다");
  });
});

describe("다국어 — 번역하면 안 되는 것", () => {
  it("커머스 대가성 문구는 한국어 원문 그대로다 (제공자가 정한 문장)", () => {
    // commerce.ts 주석이 못 박은 대로 "우리가 짓지 않는다". 임의 번역은 규정 위반이 될 수 있다.
    const commerce = read("apps/server/src/commerce/commerce.ts");
    assert.match(commerce, /disclosure: "이 포스팅은 쿠팡 파트너스 활동의 일환으로/,
      "대가성 문구가 바뀌었다 — 번역·의역 대상이 아니다");
    assert.doesNotMatch(commerce, /langOf|CAPTION_LANGS|translate/,
      "대가성 문구에 언어 분기가 들어갔다 — 쿠팡이 베트남어 문구를 주기 전엔 원문 고정");
  });
});

// ── 메타데이터 생성 (소스 스캔) ────────────────────────────────────────────────

describe("다국어 — 메타는 번역이 아니라 생성이다", () => {
  const meta = read("apps/server/src/pipeline/clip-metadata.ts");

  it("한국어면 프롬프트가 종전과 한 바이트도 다르지 않다", () => {
    assert.match(meta, /isForeign\(lang\) \? langBlock\(lang\) : null/,
      "언어 블록이 조건부가 아니면 한국어 메타 품질이 달라진다");
  });

  it("제목 길이 상한이 언어 폭을 따른다", () => {
    assert.match(meta, /\$\{lang\.titleMaxChars\}자 이내로 쓴다/);
    assert.ok(CAPTION_LANGS.vi.titleMaxChars > CAPTION_LANGS.ko.titleMaxChars);
  });

  it("언어 블록은 프롬프트 맨 뒤에 있다 — 앞쪽 캐시를 깨지 않게", () => {
    const body = meta.slice(meta.indexOf("export function buildMetadataPrompt"));
    assert.ok(body.indexOf("langBlock(lang)") > body.indexOf("PRODUCT_QUERY_BLOCK"),
      "언어 지시가 고정 블록 앞에 끼면 프롬프트 캐시가 매번 깨진다");
  });
});
