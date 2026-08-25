/**
 * 템플릿 슬라이더 ↔ 규칙 저장 화이트리스트 파리티.
 *
 * 실패 클래스: 화면(LayoutState)에 조절 필드를 추가하고 라우트 화이트리스트를 잊으면,
 * 슬라이더는 움직이는데 저장에서 **조용히 유실**된다 — titleColor 가 정확히 그렇게 새고
 * 있었다(2026-08-25 점검에서 발견·수정). 두 소스를 대조해 재발을 컴파일 전에 잡는다.
 * (docs-drift 와 같은 소스 스캔 방식 — 순수 함수로 증명할 수 없는 불변식이다.)
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("자동배포 layout — 화면 필드가 저장 화이트리스트에 전부 있다", () => {
  it("LayoutState 의 모든 키가 POST /api/automation/rules 화이트리스트에 등장한다", () => {
    const preview = read("apps/web/src/components/automation/template-preview.tsx");
    const typeBlock = /export type LayoutState = \{([\s\S]*?)\};/.exec(preview)?.[1];
    assert.ok(typeBlock, "template-preview.tsx 에서 LayoutState 정의를 못 찾았다");
    const fields = [...typeBlock!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    assert.ok(fields.length >= 8, `LayoutState 필드가 너무 적게 파싱됐다: ${fields.join(", ")}`);

    const index = read("apps/server/src/index.ts");
    const block = /const l = body\.layout as Record[\s\S]*?return Object\.keys\(layout\)\.length/.exec(index)?.[0];
    assert.ok(block, "index.ts 에서 layout 화이트리스트 블록을 못 찾았다");

    for (const field of fields) {
      assert.ok(
        block!.includes(`"${field}"`) || block!.includes(`l.${field}`),
        `화면 슬라이더 필드 '${field}' 가 규칙 저장 화이트리스트에 없다 — 조절해도 조용히 유실된다`,
      );
    }
  });

  it("화이트리스트의 숫자·색 필드는 factory 시드(layoutOverride)도 안다", () => {
    // 저장은 되는데 시드가 안 읽으면 결과물에 반영이 안 된다 — 반대 방향 파리티.
    const factory = read("apps/server/src/factory.ts");
    const typeBlock = /layoutOverride\?: \{([\s\S]*?)\}/.exec(factory)?.[1];
    assert.ok(typeBlock, "factory.ts 에서 layoutOverride 타입을 못 찾았다");
    for (const field of ["titleY", "channelIconY", "channelBoxY", "channelIconSize",
      "titleColor", "subtitleY", "subtitleSize", "subtitleColor", "title", "logo", "timebox"]) {
      assert.ok(typeBlock!.includes(field), `factory layoutOverride 에 '${field}' 가 없다`);
    }
  });
});
