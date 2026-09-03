/**
 * 도움말 문서(`docs/help/*.md`)가 **챗봇이 쓸 수 있는 상태인지**, 그리고 **프로덕션까지
 * 도달하는지** 검사한다.
 *
 * ## 도달성을 왜 테스트가 보나
 *
 * 서버 이미지는 `apps/server`·`core`·`assets/*` 만 COPY 한다. `docs/help` COPY 를 빼먹으면
 * **로컬은 멀쩡하고 프로덕션만** 지식이 빈 채로 돈다 — 챗봇은 에러를 내지 않고 그럴듯한
 * 일반론으로 답한다. 이 리포의 최빈 실패모드("기능은 있는데 출력이 소비처에 미도달")가
 * 정확히 이 모양이라, Dockerfile 의 그 한 줄을 여기서 붙잡아 둔다.
 *
 * ## 금지어를 왜 보나
 *
 * 이 문서는 **고객이 읽는 답의 원천**이다. 원가·마진 같은 내부 사실이 한 줄이라도 들어가면
 * 챗봇이 그걸 자연스럽게 인용하고, 화면에는 에러가 아니라 **잘 쓴 답변처럼** 나온다.
 * 새는 걸 알아채는 사람이 없다 — 그래서 문서 자체를 방어선으로 삼는다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { HELP_DIR, DOC_CHAR_LIMIT, loadHelpDocs } from "../chatbot/help.ts";
import { SCREENS } from "../chatbot/catalog.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = path.resolve(SRC, "..", "Dockerfile");

/**
 * 고객 답변에 절대 섞이면 안 되는 말 — 전부 **우리 내부 사실**이다.
 *
 * 정규식인 이유: "원가" 를 그냥 부분일치로 찾으면 **"회원가입"** 이 걸린다. 오탐이 나면
 * 사람이 검사를 느슨하게 고치게 되고, 그러면 진짜가 새기 시작한다 — 그래서 처음부터
 * 정확히 잡는다.
 */
const BANNED: RegExp[] = [
  /(?<!회)원가/, /마진/, /gemini/i, /vertex/i, /cloud run/i, /\bgcs\b/i, /postgres/i,
  /cloud sql/i, /flash-lite/i, /soniox/i, /pgvector/i, /ffmpeg/i, /워커/,
];

describe("도움말 문서", () => {
  const docs = loadHelpDocs();
  const screens = new Set(SCREENS.map((s) => s.href));

  it("문서가 존재한다 — 없으면 챗봇이 제품을 모른 채 답한다", () => {
    assert.ok(docs.length >= 10, `docs/help 문서가 ${docs.length}편뿐이다 (${HELP_DIR})`);
  });

  it("모든 문서에 제목과 키워드가 있다", () => {
    for (const d of docs) {
      assert.ok(d.title && d.title !== `${d.name}.md`, `${d.name}: title 프런트매터가 없다`);
      assert.ok(d.keywords.length >= 3, `${d.name}: keywords 가 ${d.keywords.length}개뿐이다 — 검색이 안 걸린다`);
      assert.ok(d.body.length > 200, `${d.name}: 본문이 너무 짧다`);
    }
  });

  it("screen 이 실재하는 화면을 가리킨다", () => {
    for (const d of docs) {
      if (!d.screen) continue; // FAQ 처럼 화면이 없는 문서는 허용
      assert.ok(screens.has(d.screen), `${d.name}: screen "${d.screen}" 이 카탈로그에 없다`);
    }
  });

  it("화면이 지정된 문서가 절반 이상이다 — 화면 맥락으로 고를 수 있어야 한다", () => {
    const withScreen = docs.filter((d) => d.screen).length;
    assert.ok(withScreen >= docs.length / 2, `화면 지정 문서가 ${withScreen}/${docs.length} 뿐이다`);
  });

  it("내부 사실(원가·인프라·모델 이름)이 들어 있지 않다", () => {
    const hits: string[] = [];
    for (const d of docs) {
      for (const re of BANNED) {
        const m = re.exec(d.body);
        if (m) hits.push(`${d.name}: "${m[0]}"`);
      }
    }
    assert.deepEqual(hits, [],
      `고객이 읽는 문서에 내부 사실이 있다 — 챗봇이 그대로 인용한다:\n  ${hits.join("\n  ")}`);
  });

  it("한 편이 프롬프트 상한을 크게 넘지 않는다", () => {
    // 넘으면 잘려 나가므로 뒷부분이 답변에 영영 안 실린다. 두 배까지는 경고 없이 두되,
    // 그 이상이면 문서를 쪼개야 한다.
    for (const d of docs) {
      assert.ok(d.body.length < DOC_CHAR_LIMIT * 2,
        `${d.name}: ${d.body.length}자 — ${DOC_CHAR_LIMIT}자에서 잘린다. 문서를 나눌 것`);
    }
  });

  it("Dockerfile 이 docs/help 를 이미지에 넣는다 — 빠지면 프로덕션만 조용히 무지해진다", () => {
    const df = fs.readFileSync(DOCKERFILE, "utf-8");
    assert.match(df, /^COPY\s+docs\/help\s+docs\/help\s*$/m,
      "apps/server/Dockerfile 에 `COPY docs/help docs/help` 가 없다");
  });
});
