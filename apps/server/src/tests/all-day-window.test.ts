/**
 * 자동배포 시간 제한 없애기 — **24시간** (사용자 2026-09-02 "9시~21시 하드리미트 없애자").
 *
 * 예전 기본은 9~22 였고, 그게 곧 "밤에 올린 회차는 아침까지 안 나간다" 였다. 이제 기본이
 * 24시간이다. 이 파일이 고정하는 것 셋:
 *  1. 기본값이 실제로 24시간이고, 어느 시각에도 순방이 돈다.
 *  2. **저장된 계획의 시간대는 안 바뀐다** — 기본값 변경이 기존 고객 계획을 건드리면 안 된다.
 *  3. 24시간 계획에도 **리포트 마감이 온다.** 여기가 함정이었다: 마감이 `end * 60` 이라
 *     24시간(=1440)이면 kstMinutes(최대 1439)가 절대 못 넘어 리포트가 하루 늦는다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inActiveWindow, isAllDayWindow, ruleWindow, type AutomationRule,
} from "../pipeline/automation.ts";
import { ruleDayTarget } from "../publish/publish-notify.ts";

const at = (hhmm: string) => new Date(`2026-09-02T${hhmm}:00+09:00`);
const rule = (o: Partial<AutomationRule>) => o as AutomationRule;

describe("기본이 24시간이다", () => {
  it("활동창 기본값 = 0~24 (예전 9~22)", () => {
    assert.deepEqual(ruleWindow({}), { start: 0, end: 24 });
  });

  it("기본 계획은 새벽·한밤에도 순방이 돈다 — 이게 '하드리미트 없앰' 의 본체", () => {
    for (const t of ["00:30", "03:00", "07:59", "13:00", "21:30", "23:59"]) {
      assert.equal(inActiveWindow(rule({}), at(t)), true, `${t} 에 창 밖으로 판정됐다`);
    }
  });

  it("isAllDayWindow 는 두 표기를 모두 24시간으로 본다", () => {
    assert.equal(isAllDayWindow({ activeStart: 0, activeEnd: 24 }), true, "0~24");
    assert.equal(isAllDayWindow({ activeStart: 9, activeEnd: 9 }), true, "start===end(옛 표기)");
    assert.equal(isAllDayWindow({}), true, "미지정 = 기본 24시간");
    assert.equal(isAllDayWindow({ activeStart: 9, activeEnd: 22 }), false);
  });
});

describe("저장된 계획의 시간대는 그대로다 — 기본값을 바꿔도", () => {
  const nine2ten = rule({ activeStart: 9, activeEnd: 22 });

  it("9~22 계획은 여전히 9~22 다", () => {
    assert.deepEqual(ruleWindow(nine2ten), { start: 9, end: 22 });
    assert.equal(inActiveWindow(nine2ten, at("08:30")), false);
    assert.equal(inActiveWindow(nine2ten, at("09:00")), true);
    assert.equal(inActiveWindow(nine2ten, at("21:59")), true);
    assert.equal(inActiveWindow(nine2ten, at("22:00")), false, "end 는 배타여야 한다(종전 동작)");
  });

  it("자정을 넘기는 창(22~2)도 종전대로 돈다", () => {
    const overnight = rule({ activeStart: 22, activeEnd: 2 });
    assert.equal(inActiveWindow(overnight, at("23:00")), true);
    assert.equal(inActiveWindow(overnight, at("01:00")), true);
    assert.equal(inActiveWindow(overnight, at("12:00")), false);
  });
});

describe("24시간 계획에도 리포트 마감이 온다 (함정)", () => {
  const allDay = { dailyQuota: 3, activeEnd: 24 };

  it("자정 직전(23:59)에 마감이 지난 것으로 본다 — 안 그러면 리포트가 하루 늦는다", () => {
    assert.equal(ruleDayTarget(allDay, 0, at("23:59")).deadlinePassed, true,
      "end*60 = 1440 은 kstMinutes(최대 1439)가 못 넘는다 — 23:59 로 접어야 한다");
  });

  it("낮 시간엔 아직 마감 전이다 — 하루 한 통 정책이 깨지면 안 된다", () => {
    for (const t of ["09:00", "18:00", "23:00"]) {
      assert.equal(ruleDayTarget(allDay, 0, at(t)).deadlinePassed, false, `${t}`);
    }
  });

  it("창이 있는 계획은 그 끝이 마감이다 (9~22 → 22:00)", () => {
    const windowed = { dailyQuota: 3, activeEnd: 22 };
    assert.equal(ruleDayTarget(windowed, 0, at("21:59")).deadlinePassed, false);
    assert.equal(ruleDayTarget(windowed, 0, at("22:00")).deadlinePassed, true);
  });

  it("activeEnd 미지정도 24시간으로 읽고 마감이 온다", () => {
    assert.equal(ruleDayTarget({ dailyQuota: 3 }, 0, at("23:59")).deadlinePassed, true);
    assert.equal(ruleDayTarget({ dailyQuota: 3 }, 0, at("12:00")).deadlinePassed, false);
  });
});

describe("새 계획 기본값이 서버·DB·화면에서 같다", () => {
  it("db-pg 의 신규 계획 기본이 0/24 — 화면이 값을 안 보내도 24시간", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
    const db = fs.readFileSync(path.join(SRC, "db-pg.ts"), "utf-8");
    assert.match(db, /r\.activeStart \?\? 0, r\.activeEnd \?\? 24,/,
      "DB 기본이 9/22 로 남아 있으면 화면만 24시간이고 저장은 9~22 가 된다");
    assert.doesNotMatch(db, /r\.activeStart \?\? 9/);
  });
});
