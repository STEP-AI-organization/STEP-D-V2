/**
 * **모은 것이 화면까지 닿는가.** 이 리포에서 제일 자주 나는 실패 방식이라 여기서 고정한다.
 *
 * 실측 2026-09-02: 워커(`video.analyze`·`video.comments`)가 유입경로·시청자 연령/성별·
 * 시청 지속 곡선·상위 댓글을 **계속 모으고 있었는데 보여 주는 화면이 하나도 없었다.**
 * 서버 라우트도 웹 API 함수도(`fetchVideoAnalytics`) 멀쩡했다 — 부르는 화면만 0 이었다.
 * 프론트 개편 때 안 옮겨졌고, 타입체크·빌드·테스트가 전부 초록이라 아무도 못 봤다.
 *
 * 왜 이게 그냥 미완성이 아니라 **위험**인가: 우리는 그 데이터를 계속 받아서 저장한다.
 * 유튜브 API 컴플라이언스 심사는 "요구한 범위가 제품 기능으로 뒷받침되는가" 를 본다 —
 * 쓰지 않는 데이터를 계속 받는 건 지적 대상이다(2026-08-31 `channel-memberships` 제거와 같은 결).
 *
 * 그래서 **생산(워커) → 저장(라우트) → 소비(화면)** 세 단이 다 있는지를 본다.
 * 화면을 지울 거면 수집도 같이 지워야 한다 — 그때 이 테스트가 빨간불을 켠다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SRC, "../../..");
const read = (p: string) => fs.readFileSync(path.resolve(REPO, p), "utf-8");

const index = read("apps/server/src/index.ts");
const worker = read("apps/server/src/worker.ts");
const webApi = read("apps/web/src/lib/data/api.ts");

/** `apps/web/src` 안의 화면·컴포넌트 전부 (API 클라이언트 자신은 뺀다 — 정의는 소비가 아니다). */
function webScreens(): string {
  const root = path.resolve(REPO, "apps/web/src");
  let out = "";
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      if (p.endsWith(path.join("lib", "data", "api.ts"))) continue;
      out += fs.readFileSync(p, "utf-8");
    }
  };
  walk(root);
  return out;
}

const screens = webScreens();

describe("유튜브 상세 지표 — 모은 것이 화면까지 닿는다", () => {
  it("워커가 모은다 (생산)", () => {
    assert.match(worker, /"video\.analyze"/);
    assert.match(worker, /"video\.comments"/);
  });

  it("라우트가 내려 준다 (저장→전달)", () => {
    assert.ok(index.includes('app.get("/api/youtube/videos/:videoId/analytics"'));
    for (const field of ["trafficSources", "demographics", "retention", "comments"]) {
      assert.ok(index.includes(`${field}:`), `${field} 를 응답에 안 담는다`);
    }
  });

  it("**화면이 그걸 부른다 (소비)** — 여기가 끊겨 있었다", () => {
    assert.ok(webApi.includes("export async function fetchVideoAnalytics"),
      "웹 API 함수가 없다");
    assert.ok(screens.includes("fetchVideoAnalytics("),
      "부르는 화면이 없다 — 모으기만 하고 아무도 안 본다");
  });

  it("화면이 **네 가지를 다** 보여 준다 — 하나만 빠져도 그 수집은 근거를 잃는다", () => {
    for (const field of ["trafficSources", "demographics", "retention", "comments"]) {
      assert.ok(screens.includes(field), `화면이 ${field} 를 안 쓴다`);
    }
  });

  it("메뉴에 **살아 있는 항목**으로 있다 — soon 이면 사람이 안 누른다", () => {
    const nav = read("apps/web/src/lib/nav.ts");
    const line = nav.split("\n").find((l) => l.includes('href: "/channel-analytics"')) ?? "";
    assert.ok(line, "채널 분석 메뉴가 없다");
    assert.ok(!line.includes("soon: true"), "화면을 채웠으면 soon 을 떼야 한다");
  });

  it("**언제 모은 값인지** 화면에 적는다 — 라이브 조회가 아니다", () => {
    // 성과(/performance)는 매번 라이브로 읽고, 이 화면은 워커가 모아 둔 걸 읽는다.
    // 시점을 안 적으면 오래된 수치를 지금 값으로 읽는다.
    const page = read("apps/web/src/app/(app)/channel-analytics/page.tsx");
    assert.ok(page.includes("data.fetchedAt"), "수집 시각을 안 쓴다");
    assert.match(page, /수집/);
  });

  it("없는 값은 **0 이 아니라 —** 다 (F9 ⊘)", () => {
    const page = read("apps/web/src/app/(app)/channel-analytics/page.tsx");
    assert.ok(page.includes('"—"'), "수집 전과 실제 0 을 구별하지 않는다");
  });
});
