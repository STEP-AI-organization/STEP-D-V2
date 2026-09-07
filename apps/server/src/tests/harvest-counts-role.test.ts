/**
 * 수확 카운터는 **원본만 센다** — 우리가 렌더한 클립을 회차로 세면 자동화가 멈춘다.
 *
 * 순수 함수로 증명할 수 없는 불변식이라 소스를 스캔한다(이 리포의 `worker-lanes`·`docs-drift`
 * 와 같은 종류). SQL 이 담고 있는 판정이고, 그 판정이 틀리면 **DB 를 띄워야만** 드러난다.
 *
 * ## 왜 이 테스트가 있나 (2026-09-07 프로덕션 실사고)
 *
 * 회차 하나에는 원본(role='master')과 우리가 렌더한 숏폼(role='clip')이 **같은 episodeId 로**
 * 매달린다. 분석 완료 표시(`content_analysis`)는 원본에만 붙으므로, 클립은 영원히
 * "분석 안 끝난 미디어" 다. `harvestCounts` 가 role 을 안 가리면 그 클립들이
 *
 *   · `inFlight` 로 세어져 `MAX_IN_FLIGHT=1` 에 걸린다 → **배포한 날 밤 수확이 통째로 막힌다**
 *     (실측: 09-04 밤 4회 전부 "앞 영상이 아직 처리 중입니다" · 그날 수확 0편)
 *   · 24시간 뒤엔 `stuck` 으로 넘어가 **"N편이 멈춰 있습니다 — 사무실 PC를 확인하세요"** 라는
 *     거짓 경고를 매일 찍는다 (그 PC 는 멀쩡했다 — 사람을 엉뚱한 기계로 보낸다)
 *   · `madeToday` 도 부풀어 하루 상한을 잘못 채운다
 *
 * 세 증상이 전부 "조용히 안 도는" 쪽이라, 경고를 믿으면 원인을 영영 못 찾는다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..");
const DB = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf8");

/** `harvestCounts` 본문만 잘라낸다 — 파일 전체를 보면 다른 쿼리의 role 필터에 속는다. */
function harvestCountsBody(): string {
  const start = DB.indexOf("export async function harvestCounts(");
  assert.notEqual(start, -1, "harvestCounts 를 못 찾았다 — 이름이 바뀌었으면 이 테스트도 같이 고칠 것");
  const end = DB.indexOf("\nexport ", start + 1);
  return DB.slice(start, end === -1 ? undefined : end);
}

describe("수확 카운터 — 렌더한 클립을 회차로 세지 않는다", () => {
  it("harvestCounts 가 원본(master)만 센다", () => {
    const body = harvestCountsBody();
    assert.match(
      body,
      /m\.role IS NULL OR m\.role = 'master'/,
      "role 필터가 없다 — 렌더한 클립이 '분석 안 끝난 회차' 로 세어져 수확이 막힌다",
    );
  });

  it("세 카운터가 **한 쿼리**에서 나온다 — 같은 필터를 공유해야 한다", () => {
    const body = harvestCountsBody();
    // 쿼리를 쪼개면 한쪽에만 role 필터가 붙는 날이 온다. 셋 다 같은 FROM 절을 봐야 한다.
    assert.equal((body.match(/FROM media m/g) ?? []).length, 1, "media 를 두 번 이상 훑고 있다");
    for (const col of ["made_today", "in_flight", "stuck"]) {
      assert.ok(body.includes(col), `${col} 이 이 쿼리에 없다`);
    }
  });

  it("분석 완료 판정은 content_analysis 존재 여부다 — 원본에만 붙는다는 전제의 근거", () => {
    const body = harvestCountsBody();
    assert.match(body, /FROM content_analysis ca WHERE ca\.mediaId = m\.id/);
  });
});
