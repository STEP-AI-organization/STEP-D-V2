/**
 * **발행된 뒤 제목/설명을 고치면 채널에 반영된다** — 그 배선이 끊기지 않게 고정한다.
 *
 * 이 경로의 실패 모양은 전부 "조용함" 이다. 재업로드가 아니라 videos.update 라 사고가 나도
 * 화면에 아무 일이 안 생기고, 자동 재시도도 없다(F4-4). 그래서 세 지점을 못으로 박는다:
 *
 *  ① 발행된 건의 수정은 **재발행이 아니다** — 재발행하면 같은 영상이 채널에 하나 더 생긴다.
 *  ② 결과가 **배포 행에 남는다** — 안 남으면 누른 사람은 "요청했다" 까지만 알고, 토큰이
 *    만료돼 반영이 통째로 버려져도 채널엔 옛 제목이 그대로인 걸 아무도 모른다.
 *  ③ 그 상태를 **화면이 읽는다** — 이 리포의 최빈 실패모드가 "기능은 있는데 출력이
 *    소비처에 미도달" 이다. 서버만 고치고 끝내면 이번에도 같은 자리에서 멈춘다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.resolve(SRC, "../../web/src");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf-8");
const readWeb = (p: string) => fs.readFileSync(path.join(WEB, p), "utf-8");

/** 최상위 `}` 로 끝나는 함수 하나를 통째로 잘라 온다. */
function fn(source: string, signature: string): string {
  const m = new RegExp(`${signature}[\\s\\S]*?\\n\\}(?=\\r?\\n)`).exec(source);
  assert.ok(m, `${signature} 를 못 찾았다`);
  return m![0];
}

describe("발행 후 메타 수정 — 재발행이 아니라 기존 영상 수정", () => {
  const index = read("index.ts");
  const worker = read("worker.ts");

  it("발행된 건의 재시도는 막고 메타 수정 경로로 보낸다", () => {
    assert.match(index, /\/api\/distributions\/update-metadata/,
      "재발행을 막아 놓고 갈 곳이 없으면 사람은 결국 재업로드를 누른다(중복 게시)");
  });

  it("라우트는 잡만 큐잉하고, **큐잉했다는 사실을 행에 적는다**", () => {
    const route = /app\.post\("\/api\/distributions\/update-metadata"[\s\S]*?\n\}\);/.exec(index)?.[0] ?? "";
    assert.notEqual(route, "", "update-metadata 라우트를 못 찾았다");
    assert.match(route, /enqueue\(\s*\n?\s*"distribution\.updatemeta"/,
      "라우트가 직접 유튜브를 부르면 안 된다 — 채널 토큰은 워커가 쥔다");
    assert.match(route, /metaSyncStatus:\s*"pending"/,
      "큐잉을 행에 안 적으면 누른 뒤 화면에 아무 변화가 없다");
    // 여러 유튜브 채널에 나간 클립이면 나간 곳 전부 — 하나만 고치고 '반영됨' 이라 말하면 거짓말이다.
    assert.match(route, /videoId:\s*String\(row\.externalId\)/,
      "잡이 어느 영상을 고칠지 지목하지 않으면 다계정에서 엉뚱한 영상이 수정된다");
  });

  it("워커는 성공·실패를 **양쪽 다** 배포 행에 남긴다", () => {
    const handler = fn(worker, "async function handleDistributionUpdateMeta");
    assert.match(handler, /metaSyncStatus:\s*"synced"/, "성공을 기록하지 않는다");
    assert.match(handler, /metaSyncStatus:\s*"failed"/,
      "실패가 로그에만 남는다 — 자동 재시도가 없는 경로라 아무도 모르면 영원히 안 고쳐진다");
    assert.match(handler, /metaSyncError/, "실패 사유가 없으면 사람이 무엇을 고쳐야 할지 모른다");
  });

  it("결과 기록이 **유령 배포 행을 만들지 않는다**", () => {
    const rec = fn(worker, "async function recordMetaSync");
    assert.match(rec, /if \(!rows\.some\(/,
      "행이 없을 때 새로 만들면 status 없는 배포 행이 생겨 배포 매트릭스가 깨진다");
  });

  it("잡이 지목한 영상을 고친다 (지목 없는 구 잡은 예전대로)", () => {
    const handler = fn(worker, "async function handleDistributionUpdateMeta");
    assert.match(handler, /job\.payload\.videoId/, "지목을 무시하면 첫 행만 영원히 고쳐진다");
  });
});

describe("배선 — 반영 상태가 화면까지 간다", () => {
  it("웹이 반영 라우트를 부른다", () => {
    const api = readWeb("lib/data/api.ts");
    assert.match(api, /distributions\/update-metadata/,
      "서버에만 있고 화면에서 부를 수 없으면 사람은 이 기능을 쓸 수 없다");
  });

  it("미디어 상세가 반영 버튼과 결과를 그린다", () => {
    const detail = readWeb("components/media/clip-detail.tsx");
    assert.match(detail, /syncLiveMetadata/, "저장만 하고 채널에 반영하는 자리가 없다");
    assert.match(detail, /metaSyncStatus/, "반영 성공·실패가 화면에 안 나온다");
  });

  it("배포판에서도 들어갈 수 있다 — 배포된 영상을 보는 자리가 거기다", () => {
    const page = readWeb("app/(app)/distribution/page.tsx");
    assert.match(page, /onEditMeta/,
      "배포판에 입구가 없으면 사람은 유튜브 스튜디오로 나가서 고친다(우리 기록과 어긋난다)");
  });
});
