/**
 * **요구하는 유튜브 스코프는 전부 쓰는 것이어야 한다** (2026-08-31).
 *
 * 유튜브 API 컴플라이언스 심사가 정확히 이 지점을 본다 — "기능에 필요한 최소 범위만
 * 요구하는가". 대응 기능 없는 스코프는 심사 지적이 되고, 그 전에 사용자에게 안 쓰는 권한을
 * 내주게 한다. 실제로 `youtube.channel-memberships.creator` 를 동의 화면에서 받으면서
 * 멤버십 API 는 **한 번도 부르지 않는 상태**로 오래 있었다(2026-08-31 심사 회신 준비 중 발견).
 *
 * 스코프는 코드로 증명되지 않는 종류의 약속이라(호출부가 없어도 빌드는 통과한다)
 * 소스 스캔으로 고정한다. 스코프를 늘릴 때는 **그걸 부르는 코드가 먼저** 있어야 한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
const youtube = fs.readFileSync(path.join(SRC, "youtube.ts"), "utf-8");

/** 동의 요청에 들어가는 스코프만 뽑는다(주석에 적힌 것은 세지 않는다). */
function scopesIn(block: string): string[] {
  return [...block.matchAll(/"https:\/\/www\.googleapis\.com\/auth\/([\w.-]+)"/g)].map((m) => m[1]);
}
const cut = (name: string) => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(index);
  assert.ok(m, `${name} 를 못 찾았다`);
  return m![1];
};

const publish = scopesIn(cut("YT_PUBLISH_SCOPES"));
const analytics = scopesIn(cut("YT_ANALYTICS_SCOPES"));

describe("유튜브 동의 스코프 — 요구하는 건 전부 쓴다", () => {
  it("멤버십 스코프를 요구하지 않는다 — 부르는 코드가 없다", () => {
    const all = [...publish, ...analytics];
    assert.ok(!all.some((s) => s.includes("channel-memberships")),
      "멤버십 스코프를 다시 넣었다. 멤버십 API 를 실제로 부르는 코드가 없으면 심사 지적 항목이다");
  });

  it("쓰기 스코프는 업로드가 실제로 쓰는 둘뿐이다", () => {
    // youtube        → videos.insert/update · thumbnails.set
    // youtube.force-ssl → 위 호출의 전제(HTTPS 강제)
    assert.deepEqual([...publish].sort(), ["youtube", "youtube.force-ssl"],
      "업로드 동의에 스코프를 늘렸다면, 그걸 부르는 코드가 먼저 있어야 한다");
  });

  it("외부 크리에이터 연결은 **읽기 전용**이다", () => {
    // 이 리프레시 토큰은 우리 DB 에 남는다. 쓰기 스코프가 섞이면 토큰 유출이 곧 남의 채널
    // 영상 수정·삭제 권한이 된다 — 읽기 전용이 그 사고의 상한을 정한다.
    for (const s of analytics) {
      assert.ok(s.endsWith(".readonly"), `분석 연결에 쓰기 스코프가 섞였다: ${s}`);
    }
    assert.ok(analytics.length >= 3, "분석에 필요한 스코프가 빠졌다");
  });

  it("업로드 가능 판정은 한 곳에서만 한다 — 문자열을 흩뿌리면 재연동해도 권한 없음이 난다", () => {
    assert.match(youtube, /export const YT_PUBLISH_SCOPE = "https:\/\/www\.googleapis\.com\/auth\/youtube"/);
    assert.match(youtube, /export function scopeCanPublish/);
    // 판정이 `youtube` 하나만 보므로, 위에서 스코프를 빼도 **기존 연결 채널은 그대로 돈다**.
    assert.match(youtube, /includes\(YT_PUBLISH_SCOPE\)/);
  });
});
