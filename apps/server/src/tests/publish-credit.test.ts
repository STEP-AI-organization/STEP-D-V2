/**
 * 배포 과금 — 영상×채널 1크레딧, 실패 시 환급 (사용자 2026-08-26).
 *
 * 순수 함수가 아니라 배선이 본체라 소스 스캔으로 불변식을 고정한다:
 *  - 차감은 dispatch(게이트를 지나는 유일한 문)에서, 큐잉 **전에** — 실물 없이 물리지 않게
 *    record 모드는 무과금.
 *  - 환급은 워커의 실패 지점(markDistributionFailed) 한 곳 — chargeKey 기반 dedupe 라
 *    같은 실패가 두 번 지나가도 원장엔 한 번만 쌓인다.
 *  - 이번달 사용(monthUsageCredits)에 publish 가 들어가고 환급이 자연 차감된다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

describe("배포 크레딧 차감 (publish-dispatch)", () => {
  const src = read("publish-dispatch.ts");

  it("upload 모드만 차감한다 — record(기록만)는 실물이 안 나가므로 무과금 · 0이면 무과금 스위치", () => {
    assert.match(src, /if \(mode === "upload" && publishCost > 0\) \{[\s\S]*?reason: "publish"/,
      "차감이 upload 모드 + 단가>0 가드 안에 있지 않다");
  });

  it("차감 원장: -publishCost · reason publish · chargeKey·차감량을 행에 남긴다", () => {
    assert.match(src, /delta: -publishCost, reason: "publish"/);
    assert.match(src, /creditCharged: true, creditChargeKey: chargeKey, creditChargeCredits: publishCost/,
      "차감량을 행에 안 박으면 단가 변경 후 옛 차감이 새 값으로 환급돼 원장이 어긋난다");
  });

  it("차감량은 publishCredits(env PUBLISH_CREDITS · 기본 3)에서 온다", () => {
    assert.match(src, /publishCredits\(\)/, "하드코딩 숫자면 단가 변경 때마다 코드를 고쳐야 한다");
  });

  it("잔액 부족이면 자동충전 선시도 후에도 부족할 때 credits 코드로 스킵한다", () => {
    assert.match(src, /topupAndRecheck\(publishCost\)/, "완전소진 자동충전 배선(분석 게이트와 같은 처방)이 없다");
    assert.match(src, /code: "credits"/, "부족 사유가 기계가 읽는 코드로 안 남는다");
  });

  it("이미 차감된 진행 중 행은 다시 물리지 않는다 (더블클릭 이중 차감 방지)", () => {
    assert.match(src, /creditCharged === true[\s\S]*?"pending"[\s\S]*?"scheduled"/,
      "pending·scheduled 행 재디스패치가 다시 차감되면 더블클릭 한 번에 2크레딧이 나간다");
  });
});

describe("배포 실패 환급 (worker.markDistributionFailed)", () => {
  const src = read("worker.ts");

  it("차감된 행만, 행에 박힌 차감량으로, chargeKey dedupe 로 한 번만 환급한다", () => {
    assert.match(src, /delta: refund, reason: "publish_refund"/);
    assert.match(src, /Number\(prev\.creditChargeCredits\)/,
      "환급량이 현재 단가면 단가 변경 전 차감이 다른 값으로 돌아온다 — 행에 박힌 값을 쓸 것");
    assert.match(src, /dedupeKey: `\$\{prev\.creditChargeKey\}:refund`/,
      "환급 dedupe 가 chargeKey 기반이 아니면 같은 실패가 두 번 지나갈 때 이중 환급된다");
    assert.match(src, /value\.creditCharged = false/,
      "플래그를 안 내리면 재시도 새 차감과 옛 환급이 어긋난다");
  });
});

describe("publishCredits — 단가 파싱", () => {
  it("기본 3 · 0 허용(무과금 스위치) · 쓰레기는 기본값", async () => {
    const { publishCredits } = await import("../credits.ts");
    assert.equal(publishCredits({} as NodeJS.ProcessEnv), 3);
    assert.equal(publishCredits({ PUBLISH_CREDITS: "5" } as NodeJS.ProcessEnv), 5);
    assert.equal(publishCredits({ PUBLISH_CREDITS: "0" } as NodeJS.ProcessEnv), 0);
    assert.equal(publishCredits({ PUBLISH_CREDITS: "-2" } as NodeJS.ProcessEnv), 3);
    assert.equal(publishCredits({ PUBLISH_CREDITS: "abc" } as NodeJS.ProcessEnv), 3);
  });
});

describe("이번달 사용 집계", () => {
  it("monthUsageCredits 가 usage + publish 를 세고 환급을 자연 차감한다", () => {
    const src = read("db-pg.ts");
    assert.match(src, /reason IN \('usage', 'publish', 'publish_refund'\)/,
      "배포 차감이 이번달 사용 게이지에 안 잡히면 청구 예상과 어긋난다");
  });
});
