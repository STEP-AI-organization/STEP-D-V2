import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { normalizeTitleCast, titleNamesPrompt, isActorTitle, NAMELESS_TITLE } from "../ai/title-names.ts";
import { autoEditorState } from "../pipeline/factory.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "core/tests/fixtures/title-names.json"), "utf8"));

describe("배우명 제목 대응표", () => {
  it("같은 배우의 역할·별칭을 병합하고 표기를 정리한다", () => {
    assert.deepEqual(normalizeTitleCast([
      { actorName: " 김도현 ", characterNames: [" 민준 ", "민준"] },
      { actorName: "김도현", characterNames: ["강민준"] },
    ]), [{ actorName: "김도현", characterNames: ["민준", "강민준"] }]);
  });
  it("미완성 대응표와 한 역할에 여러 배우를 연결한 입력은 거절한다", () => {
    for (const raw of [null, {}, [{ actorName: "김도현", characterNames: [] }],
      [{ actorName: "김도현", characterNames: [null] }],
      [{ actorName: "김도현", characterNames: ["민준"] }, { actorName: "김준", characterNames: ["민준"] }],
      [{ actorName: "김도현", characterNames: ["민준"] }, { actorName: "민준", characterNames: ["하린"] }]]) {
      assert.throws(() => normalizeTitleCast(raw));
    }
    assert.deepEqual(normalizeTitleCast([]), []);
  });
  it("서버와 core가 같은 이름·조사·인용·배우명 포함 사례를 판단한다", () => {
    for (const entry of fixture.titles) assert.equal(isActorTitle(entry.text, fixture.program), entry.valid, entry.text);
    assert.equal(isActorTitle("강민준의 선택", {}), true);
    assert.equal(titleNamesPrompt({}), "");
    const prompt = titleNamesPrompt(fixture.program);
    assert.match(prompt, /강민준/);
    assert.match(prompt, /김도현/);
    assert.match(prompt, /예외/);
    assert.match(prompt, /해당 구간에 근거/);
  });
});

describe("자동 렌더의 실제 오버레이", () => {
  const lines = (rec: object, program = fixture.program) =>
    (autoEditorState({ kind: "short", ...rec }, "드라마", program) as any).titleLines.map((l: any) => l.text);
  it("배우 제목이 극중 이름을 담은 원문 훅에 덮이지 않는다", () => {
    const rec = { titleLine1: "김도현의 눈빛", titleLine2: "말없이 전한 진심", hookQuote: "민준아 기다려" };
    assert.deepEqual(lines(rec), ["김도현의 눈빛", "말없이 전한 진심"]);
    assert.equal(rec.hookQuote, "민준아 기다려");
    assert.deepEqual(lines(rec, {}), ["민준아 기다려"]);
  });
  it("이전 추천의 두 줄에 극중 이름이 남으면 검증한 제목으로 한 쌍을 대체한다", () => {
    assert.deepEqual(lines({ title: "김도현의 연기", titleLine1: "강민준의 선택", titleLine2: "그 결과는" }), ["김도현의 연기"]);
    assert.deepEqual(lines({ title: "강민준의 선택", hookQuote: "하린아 기다려" }), [NAMELESS_TITLE]);
  });
});

describe("배우 표기 배선", () => {
  it("설정 저장·core 전달·재생성 필터가 모두 연결된다", () => {
    const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
    const index = read("apps/server/src/index.ts");
    assert.match(index, /next\.titleCast = normalizeTitleCast\(body\.titleCast\)/);
    assert.match(index, /titleNamesPrompt\(programForPrompt\)/);
    assert.match(index, /!isActorTitle\(v, programForPrompt\)/);
    assert.match(read("apps/server/src/pipeline/content-pipeline.ts"), /ctx\.titleCast = titleCast/);
    const castSync = index.slice(index.indexOf("const previousCast ="), index.indexOf("// cast에서 사라진 이름"));
    assert.match(castSync, /previousCast\.some/);
    assert.doesNotMatch(castSync, /DELETE FROM program_cast/);
  });
});
