import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 클립(롱폼)이 유튜브로 나갈 때 **커스텀 썸네일이 붙는가**.
 *
 * 쇼츠는 유튜브가 프레임을 알아서 쓰지만 일반 영상은 썸네일이 곧 클릭률이다. 자동 프레임으로
 * 나가면 아무리 잘 뽑은 클립도 안 눌린다 — 기능이 있는데 소비처에 미도달하면 없는 것과 같다는
 * 이 리포의 최빈 실패모드를 그대로 밟는 자리라 배선을 소스 스캔으로 고정한다.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(HERE, f), "utf-8");

describe("클립 유튜브 썸네일 배선", () => {
  it("youtube.ts 가 thumbnails.set 을 부를 수 있다", () => {
    const yt = read("youtube.ts");
    assert.match(yt, /export async function setVideoThumbnail/,
      "썸네일 설정 함수가 없다 — 롱폼이 유튜브 자동 프레임으로 나간다");
    assert.match(yt, /upload\/youtube\/v3\/thumbnails\/set/);
    assert.match(yt, /2 \* 1024 \* 1024/, "유튜브 2MB 상한 검사가 없다");
  });

  it("업로드 직후 썸네일을 설정한다", () => {
    const w = read("worker.ts");
    assert.match(w, /setVideoThumbnail\(token, videoId, thumb\)/,
      "업로드는 하는데 썸네일을 안 붙인다");
  });

  it("썸네일 실패가 배포를 실패로 만들지 않는다", () => {
    // 영상은 이미 올라가 있다. 여기서 던지면 성공한 업로드가 '실패' 로 기록되고,
    // 재시도가 같은 영상을 또 올린다(중복 게시).
    const w = read("worker.ts");
    // 썸네일 설정 try/catch 전체를 떼어 본다.
    const block = /const thumb = await resolveClipThumbnail[\s\S]*?catch \(e\)[\s\S]*?\n    \}/.exec(w)?.[0] ?? "";
    assert.notEqual(block, "", "썸네일 설정 블록을 못 찾았다");
    assert.match(block, /catch[\s\S]*console\.warn/, "실패를 삼키지 말고 사유는 남겨야 한다");
    assert.doesNotMatch(block, /markDistributionFailed|throw /,
      "썸네일 실패로 배포를 실패 처리하면, 재시도가 이미 올라간 영상을 또 올린다");
  });

  it("썸네일 선택은 사람 선택 → AI 생성물 → 렌더 프레임 3단이다", () => {
    const w = read("worker.ts");
    const fn = /async function resolveClipThumbnail[\s\S]*?\n}/.exec(w)?.[0] ?? "";
    assert.notEqual(fn, "", "resolveClipThumbnail 을 못 찾았다");
    assert.match(fn, /"chosen"/, "사람이 고른 썸네일을 먼저 쓰지 않는다");
    assert.match(fn, /thumbnailPrefix\(masterId\)/, "썸네일 생성 기능 산출물을 안 본다");
    assert.match(fn, /"frame"/, "폴백(렌더 프레임)이 없다 — 셋 다 없으면 썸네일이 안 붙는다");
  });

  it("자동배포가 클립을 채택하면 썸네일 생성을 건다", () => {
    const cyc = read("automation-cycle.ts");
    assert.match(cyc, /enqueue\("thumbnail\.generate"/,
      "썸네일 생성 기능이 자동 경로에서 호출되지 않는다");
    assert.match(cyc, /dedupeKey: `thumbnail\.generate:\$\{master\.id\}`/,
      "회차당 1회로 묶지 않으면 클립마다 생성이 중복으로 돈다(원가)");
    // 세로(쇼츠) 규칙에서는 걸지 않는다 — 쇼츠는 커스텀 썸네일을 쓰지 않는다.
    assert.match(cyc, /if \(landscape && master\?\.id/);
  });
});
