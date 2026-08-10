/**
 * 콘텐츠 공장 — 스위치·상한 불변식 고정.
 *
 * FLOWS F6 은 "자동 배포는 게이트를 건너뛰지 않는다"와 "규칙이 없으면 아무것도 하지 않는다"를
 * 요구한다. 그 본체(게이트 연동)는 F3 을 세운 뒤에 붙지만, **켜지는 조건과 상한**은 지금
 * 고정해 둘 수 있다. 자동 배포에서 가장 비싼 사고는 "의도치 않게 켜져 있었다"이기 때문이다.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { dailyCap, factoryEnabled, publicizeDelayMs } from "./factory.ts";

const KEYS = ["FACTORY_ENABLED", "FACTORY_DAILY_CAP", "FACTORY_PUBLICIZE_DELAY_MIN"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    const v = original[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setEnv(key: (typeof KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("공장 킬 스위치", () => {
  it("미설정이면 꺼져 있다", () => {
    setEnv("FACTORY_ENABLED", undefined);
    assert.equal(factoryEnabled(), false);
  });

  it("명시적 truthy 에서만 켜진다", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      setEnv("FACTORY_ENABLED", v);
      assert.equal(factoryEnabled(), true, `${JSON.stringify(v)} 는 ON`);
    }
  });

  it("오타·유사값은 꺼진다 — 실수로 자동 배포가 도는 쪽으로 기울지 않는다", () => {
    for (const v of ["", " ", "ture", "y", "enabled", "0", "false", "off", "no"]) {
      setEnv("FACTORY_ENABLED", v);
      assert.equal(factoryEnabled(), false, `${JSON.stringify(v)} 는 OFF`);
    }
  });
});

describe("일일 상한", () => {
  it("미설정이면 5", () => {
    setEnv("FACTORY_DAILY_CAP", undefined);
    assert.equal(dailyCap(), 5);
  });

  it("숫자를 그대로 쓴다", () => {
    setEnv("FACTORY_DAILY_CAP", "12");
    assert.equal(dailyCap(), 12);
  });

  it("0·음수·비숫자는 기본값으로 되돌린다 — 상한 없음으로 해석되면 안 된다", () => {
    // "0" 을 '무제한'으로 읽는 순간 사고가 무한히 커진다. 기본값(5)로 떨어뜨린다.
    for (const v of ["0", "-1", "abc", "", " "]) {
      setEnv("FACTORY_DAILY_CAP", v);
      assert.equal(dailyCap(), 5, `${JSON.stringify(v)} 는 기본값이어야 한다`);
    }
  });
});

describe("공개 전환 유예", () => {
  it("미설정이면 10분", () => {
    setEnv("FACTORY_PUBLICIZE_DELAY_MIN", undefined);
    assert.equal(publicizeDelayMs(), 10 * 60_000);
  });

  it("0 은 허용한다 — '유예 없음'은 의도할 수 있는 선택이다", () => {
    setEnv("FACTORY_PUBLICIZE_DELAY_MIN", "0");
    assert.equal(publicizeDelayMs(), 0);
  });

  it("음수·비숫자는 기본값으로 — 과거 시각으로 즉시 공개되는 일이 없어야 한다", () => {
    for (const v of ["-5", "abc", ""]) {
      setEnv("FACTORY_PUBLICIZE_DELAY_MIN", v);
      assert.equal(publicizeDelayMs(), 10 * 60_000, `${JSON.stringify(v)} 는 기본값`);
    }
  });
});
