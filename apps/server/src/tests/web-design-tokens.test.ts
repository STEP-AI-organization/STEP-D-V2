import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 디자이너 산출물 토큰 계약 (2026-09-03 이식).
 *
 * ## 이 파일이 막는 실패
 * 프론트 재개편으로 `apps/web/src/app/globals.css` 안에 **두 개의 토큰 체계**가 공존한다:
 * 디자이너 것(`--bg-…` · `--text-…` → `@theme` 으로 `--color-…` 방출)과 우리 것(`--sd-…`).
 * 이 병합은 **깨져도 빌드·타입체크·테스트가 전부 초록이다.** 화면만 무색이 된다.
 * 그래서 눈이 아니라 여기서 잡는다.
 *
 * 특히 1번: 우리 리포 관례는 `@theme inline` 인데, 디자이너 블록은 plain `@theme` 이어야 한다.
 *   plain `@theme`  → `--color-*` 를 `:root` 에 **실제로 방출**
 *   `@theme inline` → 방출 안 하고 유틸리티에만 인라인
 * 디자이너 코드는 `bg-[var(--color-bg-card)]` 처럼 **arbitrary value 로 직접** 읽는다.
 * 관례에 맞춘답시고 `inline` 을 붙이면 그 2,600여 곳이 통째로 무색이 된다.
 *
 * **깨지면 숫자를 지우지 말고 원인을 고칠 것** — 이 테스트들은 전부 실제 사고 모양이다.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.resolve(HERE, "../../../web/src/app/globals.css");
const css = fs.readFileSync(CSS_PATH, "utf-8");

/** `@theme {` … 매칭되는 `}` 까지. `@theme inline` 은 일부러 제외한다. */
function plainThemeBlock(): string | null {
  const m = /@theme\s*\{/.exec(css);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return css.slice(m.index, i);
}

describe("디자이너 토큰 — @theme 은 plain 이어야 한다", () => {
  it("plain `@theme` 블록이 있다 (`@theme inline` 으로 바뀌지 않았다)", () => {
    assert.match(css, /@theme\s*\{/,
      "plain @theme 이 사라졌다 — --color-* 가 :root 에 안 실려 디자이너 화면이 전부 무색이 된다");
  });

  it("디자이너 색 토큰이 plain @theme 안에 있다", () => {
    const block = plainThemeBlock();
    assert.ok(block, "plain @theme 블록을 못 찾았다");
    for (const t of [
      "--color-text-primary", "--color-text-muted", "--color-border-subtle",
      "--color-bg-card", "--color-bg-input", "--color-bg-active", "--color-bg-dark",
    ]) {
      assert.ok(block!.includes(t), `${t} 가 plain @theme 에서 빠졌다`);
    }
  });

  it("우리 `@theme inline` 은 따로 남아 있다 — 두 블록은 다른 것이다", () => {
    assert.match(css, /@theme\s+inline\s*\{/,
      "우리 시맨틱 토큰(--color-foreground 등)이 사는 블록이다. 지우면 옛 프리미티브가 무색이 된다");
  });
});

describe("디자이너 토큰 — 라이트/다크 양쪽에 값이 있다", () => {
  // 한쪽만 있으면 그 테마에서 값이 상속돼 **틀린 색**이 나온다. 빌드는 통과한다.
  const themed = [
    "--bg-dark", "--bg-card", "--bg-card-hover", "--bg-input", "--bg-accent-subtle",
    "--border-subtle", "--border-card",
    "--text-primary", "--text-secondary", "--text-muted", "--text-accent", "--text-blue-light",
    "--badge-bg", "--badge-text", "--status-success-bg", "--status-success-text",
  ];

  function block(sel: string): string {
    const m = new RegExp(`${sel}\\s*\\{`).exec(css);
    assert.ok(m, `${sel} 블록이 없다`);
    let depth = 1, i = m!.index + m![0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    return css.slice(m!.index, i);
  }

  it("`html.dark` 블록이 있다", () => {
    assert.match(css, /html\.dark\s*\{/,
      "디자이너 다크 오버라이드가 사라졌다 — 다크에서 라이트 색이 그대로 나온다");
  });

  it("테마 가변 토큰이 다크에도 전부 재정의돼 있다", () => {
    const dark = block("html\\.dark");
    const missing = themed.filter((t) => !new RegExp(`${t}\\s*:`).test(dark));
    assert.deepEqual(missing, [], `다크에서 빠진 토큰: ${missing.join(", ")}`);
  });
});

describe("클래스 이름이 곧 셀렉터인 규칙 — className 을 못 바꾸는 이유", () => {
  it("카드 그림자 규칙이 살아 있다", () => {
    // 디자이너 코드의 `bg-[var(--color-bg-card)]` 문자열 자체가 이 셀렉터와 맞물린다.
    // 이식하면서 클래스를 "정리" 하면 카드 그림자가 조용히 사라진다.
    assert.match(css, /\.bg-\\\[var\\\(--color-bg-card\\\)\\\]\s*\{[^}]*box-shadow/,
      "이 규칙이 없으면 카드가 평평해진다");
  });
});

describe("우리 토큰은 지우지 않았다", () => {
  it("--sd-* 팔레트가 남아 있다", () => {
    // color-contrast.test.ts 가 :root/.dark 양쪽의 hex 존재를 강제한다. 롤아웃이 끝나
    // 정말 지울 때는 그 테스트를 디자이너 팔레트로 **먼저** 다시 쓸 것.
    for (const t of ["--sd-accent", "--sd-fg", "--sd-card", "--sd-app-bg", "--sd-mono"]) {
      assert.ok(css.includes(t), `${t} 가 사라졌다 — 아직 옛 화면이 이걸 쓴다`);
    }
  });

  it("`--font-sans` · `--font-mono` 는 우리 쪽에서 지운 상태여야 한다", () => {
    // 우리 `:root`(비레이어)가 디자이너 `@theme`(레이어)를 이겨서, 남겨 두면
    // 디자이너 화면 전체가 옛 서체로 돌아간다.
    assert.doesNotMatch(css, /--font-sans:\s*"Pretendard"/,
      "우리 --font-sans 선언이 되살아났다 — 디자이너 화면이 Pretendard 로 바뀐다");
    assert.doesNotMatch(css, /--font-mono:\s*"JetBrains Mono"/,
      "우리 --font-mono 선언이 되살아났다 — 디자이너 @theme 의 값을 덮는다");
  });

  it("고정폭이 필요한 자리는 --sd-mono 를 쓴다", () => {
    // 디자이너 `--font-mono` 는 **산세리프**다(--font-base 와 같은 스택). 거기에 기대면
    // 타임코드·잡 ID 가 가변폭으로 흔들린다.
    assert.match(css, /\.mono\s*\{\s*font-family:\s*var\(--sd-mono\)/,
      ".mono 가 디자이너 --font-mono 를 가리키면 고정폭이 아니게 된다");
  });
});

describe("전역 규칙의 적용 범위", () => {
  it("사이드바 테두리 !important 는 `.stepd-sidebar` 로 한정돼 있다", () => {
    // 원문은 `aside, aside *` 였다. 디자이너 프로젝트엔 <aside> 가 하나뿐이라 같은 결과지만,
    // 우리 리포엔 6개고 4개는 밝은 배경의 콘텐츠 사이드바다 — 흰색 10% 로 덮이면
    // 라이트 배경 위에서 테두리가 사라진다. 인라인 스타일도 !important 에 진다.
    assert.match(css, /\.stepd-sidebar,\s*\n?\s*\.stepd-sidebar \*/,
      "범위 한정이 풀렸다");
    assert.doesNotMatch(css, /^aside,\s*$/m,
      "원문 그대로의 `aside,` 셀렉터가 되살아났다 — 콘텐츠 사이드바 4곳의 테두리가 사라진다");
  });

  it("dark 변형 정의는 한 줄뿐이다", () => {
    const n = (css.match(/@custom-variant\s+dark/g) ?? []).length;
    assert.equal(n, 1, `@custom-variant dark 가 ${n}개다 — 둘이면 나중 것이 조용히 이긴다`);
  });
});
