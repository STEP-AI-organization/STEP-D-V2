/**
 * 웹이 **한 가지 화면 언어**만 쓰는지 — 소스를 읽어 고정한다.
 *
 * ## 왜 테스트로 막나
 *
 * 2026-09-11 하루에 같은 유형이 네 번 나왔다: 모달 껍데기가 옛 시스템 · 다이얼로그 7개가
 * 옛 시스템 · 폭이 어림수 · 새 폼이 shadcn 토큰. 매번 사람이 눈으로 찾아 고쳤다.
 *
 * 문서로 적어 두는 걸로는 안 됐다 — 새 파일을 만드는 사람은 그 문서를 안 읽고, 옆 파일에서
 * 복사한다. 복사원이 옛 파일이면 옛 언어가 그대로 번진다. 그래서 **기계가 막는다.**
 *
 * ⚠️ 이 테스트가 빨개지면 **금지 목록을 늘리지 말고** `components/ui/tokens.ts` 에서
 * 가져다 쓰도록 고칠 것. 목록을 예외로 채우면 관문이 무의미해진다.
 *
 * (서버 테스트 폴더에 있는 이유: 이 리포의 소스 스캔 테스트가 전부 여기 모여 있고,
 *  웹에는 테스트 러너가 없다. `docs-drift`·`worker-lanes` 와 같은 자리다.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const WEB = path.resolve(import.meta.dirname, "../../../web/src");

/** 웹 소스 전부(.tsx/.ts). node_modules·빌드 산출물은 애초에 이 아래 없다. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * ⚠️ `app/landing` 은 **구 STEPD 에서 보존한 마케팅 페이지**다. 운영자 화면과 디자인 체계가
 * 아예 다르고(자체 CSS 변수 `--mut`·`--line`) 디자이너 산출물의 대상도 아니다.
 */
const OUT_OF_SCOPE = /^app\/landing\//;

const FILES = walk(WEB)
  .map((p) => ({ path: p, rel: path.relative(WEB, p).replace(/\\/g, "/"), src: fs.readFileSync(p, "utf-8") }))
  .filter((f) => !OUT_OF_SCOPE.test(f.rel));

/** 주석을 걷어낸 본문 — 설명에 옛 토큰 이름이 나오는 건 정상이다(왜 바꿨는지 적은 자리). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("웹 화면 언어 — 옛 디자인 시스템이 다시 새지 않는다", () => {
  it("shadcn 계열 토큰을 쓰지 않는다 (디자이너 토큰이 아니다)", () => {
    // 새 파일을 만들 때 가장 흔한 실수다 — 다른 리포에서 복사해 오면 이게 딸려온다.
    // 실제로 card-registration-form.tsx 가 이 모양으로 들어왔다(2026-09-11).
    const BANNED = ["bg-background", "text-foreground", "border-input", "ring-ring", "text-muted-foreground"];
    const hits: string[] = [];
    for (const f of FILES) {
      if (f.rel.startsWith("components/ui/")) continue;   // 프리미티브는 자체 규약이 있다
      const body = code(f.src);
      for (const b of BANNED) {
        if (new RegExp(`(?<![\\w:/-])${b}(?![\\w/-])`).test(body)) hits.push(`${f.rel} → ${b}`);
      }
    }
    assert.deepEqual(hits, [],
      "shadcn 토큰은 이 화면 언어가 아니다. var(--color-*) 또는 components/ui/tokens.ts 를 쓸 것");
  });

  it("옛 sd-* 시스템을 화면에서 쓰지 않는다", () => {
    // globals.css 의 정의는 아직 남아 있다(invite·chatbot 이 쓴다). 여기서 막는 건 **새 사용**이다.
    const ALLOW = new Set(["app/invite/page.tsx", "components/chatbot/chatbot-widget.tsx"]);
    const hits: string[] = [];
    for (const f of FILES) {
      if (ALLOW.has(f.rel)) continue;
      if (/\bsd-[a-z]|--sd-[a-z]/.test(code(f.src))) hits.push(f.rel);
    }
    assert.deepEqual(hits, [],
      "옛 sd-* 토큰이 다시 들어왔다. components/ui/tokens.ts 또는 var(--color-*) 로 바꿀 것");
  });
});

describe("웹 화면 언어 — 조합은 한 곳에서 가져다 쓴다", () => {
  const TOKENS = path.join(WEB, "components/ui/tokens.ts");

  it("tokens.ts 가 있고 모달 폭 네 값을 정의한다", () => {
    assert.ok(fs.existsSync(TOKENS), "components/ui/tokens.ts 가 없다");
    const src = fs.readFileSync(TOKENS, "utf-8");
    // 원본 Tailwind 등가 — 어림수를 쓰면 모달마다 8~64px 어긋난다(2026-09-07 지적).
    for (const [key, px] of [["md", 448], ["lg", 512], ["xl", 576], ['"2xl"', 672]] as const) {
      assert.match(src, new RegExp(`${key}:\\s*${px}`),
        `MODAL_W.${key} 가 ${px}(Tailwind 등가)가 아니다`);
    }
  });

  it("다이얼로그 폭을 숫자로 직접 적지 않는다", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      // **JSX prop 만** 본다(`maxWidth={576}`). `style={{ maxWidth: 780 }}` 는 레이아웃이지
      // 다이얼로그가 아니다 — 둘을 같이 잡으면 본문 폭까지 끌려온다.
      for (const m of code(f.src).matchAll(/maxWidth=\{\s*(\d{3,4})\s*\}/g)) {
        hits.push(`${f.rel} → maxWidth ${m[1]}`);
      }
    }
    assert.deepEqual(hits, [],
      "모달 폭은 MODAL_W 에서 고른다 — 직접 적으면 원본 Tailwind 값과 어긋난다");
  });

  it("같은 버튼 조합을 파일마다 다시 정의하지 않는다", () => {
    // publish-channels 와 coupang-account 에 **글자 그대로 같은** BTN/BTN_DEL/BTN_PRIMARY 가
    // 두 벌 있었다. 한쪽만 고치면 조용히 갈라진다.
    const defs = new Map<string, string[]>();
    for (const f of FILES) {
      if (f.rel === "components/ui/tokens.ts") continue;
      for (const m of code(f.src).matchAll(/^const ([A-Z][A-Z_]*)\s*=\s*("(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*)\s*;/gm)) {
        const value = m[2].replace(/"\s*\+\s*"/g, "").replace(/"/g, "").trim();
        if (!value.includes("rounded-full") && !value.includes("rounded-xl")) continue;
        const key = value.split(/\s+/).sort().join(" ");
        defs.set(key, [...(defs.get(key) ?? []), `${f.rel}:${m[1]}`]);
      }
    }
    const dup = [...defs.values()].filter((v) => v.length > 1).map((v) => v.join(" == "));
    assert.deepEqual(dup, [],
      "같은 값이 여러 파일에 복사돼 있다 — components/ui/tokens.ts 로 올리고 import 할 것");
  });
});
