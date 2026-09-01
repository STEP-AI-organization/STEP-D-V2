import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf-8");

/**
 * **읽기에서 숨긴 것은 쓰기가 지우면 안 된다.**
 *
 * `/api/state` 는 프로그램 아이콘과 똑같은 클립 아이콘을 응답에서 뺀다(중복 바이트 제거).
 * 그런데 `PATCH /api/clips/:id/editor` 는 editorState 를 통째로 덮으므로, 뺀 상태로 화면에
 * 간 클립을 편집자가 제목만 고쳐 저장하면 그 아이콘이 **DB 에서 영영 사라진다.**
 * 응답 최적화가 조용히 데이터 손실로 바뀌는 지점이라, 왕복이 안전한지 여기서 고정한다.
 */
describe("클립 아이콘 — 응답에서 뺀 값이 저장으로 지워지지 않는다", () => {
  const index = read("index.ts");

  it("editor PATCH 가 빠진 channelIconDataUrl 을 되살린다", () => {
    const route = index.slice(index.indexOf('app.patch("/api/clips/:id/editor"'));
    const guard = route.indexOf('!("channelIconDataUrl" in');
    const patch = route.indexOf("const patch: Record<string, unknown> = { editorState: body.editorState }");
    assert.ok(guard > 0, "빠진 키를 보존하는 처리가 없다 — 편집 저장 한 번에 아이콘이 사라진다");
    assert.ok(guard < patch, "patch 를 만든 뒤에 보존하면 이미 늦다");
  });

  it("빈 문자열은 보존하지 않는다 — '지워 달라' 는 뜻이다", () => {
    const route = index.slice(index.indexOf('app.patch("/api/clips/:id/editor"'));
    assert.match(route.slice(0, 3000), /typeof priorEditor\.channelIconDataUrl === "string" && priorEditor\.channelIconDataUrl/,
      "빈 값까지 되살리면 사용자가 아이콘을 못 지운다");
  });
});

/**
 * 팬아웃 잡은 **의도를 밝히고** 들어온다.
 *
 * OAuth 연결 직후 넣는 channel.analyze 는 동기화가 아니라 영상별 잡을 뿌리려고 넣는 것이라
 * 정의상 "아무것도 안 한 실행"(0/0)이 된다. 워커의 절약 가드가 그걸 못 알아보면 새로 연결한
 * 채널이 최대 6시간 동안 영상별 분석·댓글을 하나도 못 받는다 — enqueueDueVideoJobs 가
 * 그 잡들을 넣는 유일한 경로다.
 */
describe("채널 팬아웃 — 연결 직후 잡은 절약 가드에 안 걸린다", () => {
  it("연결 흐름이 fanOut 을 붙여 넣는다", () => {
    const index = read("index.ts");
    assert.match(index, /enqueue\("channel\.analyze", \{ channelId: channel\.channelId, force: false, fanOut: true \}/,
      "이게 없으면 새 채널이 6시간 동안 영상별 잡을 못 받는다");
  });

  it("워커 가드가 fanOut 을 존중한다", () => {
    const worker = read("worker.ts");
    assert.match(worker, /if \(!job\.payload\.fanOut && result\.skipped/,
      "가드가 fanOut 을 안 보면 연결 직후 팬아웃이 조용히 사라진다");
  });
});
