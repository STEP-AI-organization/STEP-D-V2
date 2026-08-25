/**
 * 콘텐츠 공장 — 스위치·상한 불변식 고정.
 *
 * FLOWS F6 은 "자동 배포는 게이트를 건너뛰지 않는다"와 "규칙이 없으면 아무것도 하지 않는다"를
 * 요구한다. 그 본체(게이트 연동)는 F3 을 세운 뒤에 붙지만, **켜지는 조건과 상한**은 지금
 * 고정해 둘 수 있다. 자동 배포에서 가장 비싼 사고는 "의도치 않게 켜져 있었다"이기 때문이다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";

import { autoEditorState, dailyCap, factoryEnabled, mediaNeedsPreparation, publicizeDelayMs } from "./factory.ts";

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

describe("무편집 렌더 기본 프리셋", () => {
  it("쇼츠 제목 1·2줄은 출력 기준 106px·107px이고 채널은 세로 82%다", () => {
    const state = autoEditorState({
      kind: "short",
      titleLine1: "첫 번째 제목",
      titleLine2: "두 번째 제목",
    }, "STEP-D") as any;
    assert.equal(state.titleLines[0].size * 3, 106);
    assert.equal(state.titleLines[1].size * 3, 107);
    assert.equal(state.channelY, 82);
  });

  it("자동배포가 가로형을 골라도 제목 출력 크기는 106px·107px로 유지된다", () => {
    const state = autoEditorState({
      kind: "short",
      titleLine1: "첫 번째 제목",
      titleLine2: "두 번째 제목",
    }, "STEP-D", undefined, undefined, undefined, "16:9") as any;
    const scale = 1080 / ((900 * 1080) / 1920);
    assert.equal(state.aspect, "16:9");
    assert.equal(state.titleLines[0].size * scale, 106);
    assert.equal(state.titleLines[1].size * scale, 107);
    assert.equal(state.channelY, 82);
  });

  it("규칙이 고른 템플릿은 시드 표에 없어도 버리지 않는다 — 새 캔바 템플릿이 조용히 무시되던 구멍", () => {
    // 렌더는 editorState.templateId 로 자산 디렉토리를 직접 찾는다. 시드(색·위치)만 표준으로
    // 폴백하면 되고, 사용자가 고른 이름 자체가 살아야 "넣은 템플릿이 나온다"(2026-08-25 점검).
    const state = autoEditorState({
      kind: "short", titleLine1: "제목",
    }, "STEP-D", undefined, "canva-new-template") as any;
    assert.equal(state.templateId, "canva-new-template");
    assert.equal(state.channelY, 82); // 위치 시드는 broadcast-standard 폴백
  });

  it("강제 지정이 없으면 프로그램 기본 → 장르 자동 순서다", () => {
    const state = autoEditorState({
      kind: "short", titleLine1: "제목",
    }, "STEP-D", { autoPublish: { templateId: "broadcast-drama" } }) as any;
    assert.equal(state.templateId, "broadcast-drama");
    const auto = autoEditorState({
      kind: "short", titleLine1: "제목",
    }, "STEP-D", { pipelineGenre: "drama" }) as any;
    assert.equal(auto.templateId, "broadcast-drama");
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

describe("외부 API 원본 준비 대기", () => {
  it("AENA가 finalize 직후 ingest해도 duration=0 placeholder는 분석하지 않는다", () => {
    assert.equal(mediaNeedsPreparation({
      path: "gs://stepd-upload-seoul/uploads/m_aena.mp4",
      durationSec: 0,
    }), true);
  });

  it("YouTube 다운로드 중인 원본도 같은 ingest 대기 상태를 쓴다", () => {
    assert.equal(mediaNeedsPreparation({
      path: "youtube:https://youtu.be/example",
      durationSec: 3600,
    }), true);
  });

  it("media.prepare가 길이와 운영 경로를 채우면 공장 분석을 진행할 수 있다", () => {
    assert.equal(mediaNeedsPreparation({
      path: "gs://stepd-media/uploads/m_aena.mp4",
      durationSec: 3598.4,
    }), false);
  });

  it("공장 배선이 준비 전 분석 대신 media.prepare를 복구 큐잉한다", () => {
    const source = fs.readFileSync(new URL("./factory.ts", import.meta.url), "utf8");
    assert.match(source, /if \(mediaNeedsPreparation\(existing as any\)\)[\s\S]*?enqueue\("media\.prepare"/);
    assert.match(source, /case "ingesting":[\s\S]*?mediaNeedsPreparation\(media\)[\s\S]*?enqueue\("media\.prepare"/);
  });
});
