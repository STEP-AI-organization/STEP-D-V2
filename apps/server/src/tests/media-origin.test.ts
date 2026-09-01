/**
 * "+(채택)를 눌러야 미디어에 뜬다" 고정 (FLOWS F2).
 *
 * 마지막 describe 가 핵심이다. 순수 함수 테스트는 "이 함수는 추천을 안 섞는다"까지만
 * 증명한다 — 다른 파일이 클립을 새로 만들어 버리면 그만이다. 그래서 소스를 스캔해
 * **클립을 만드는 지점과 채택 경로**를 강제한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  isAdopted,
  isUndecided,
  mediaListFrom,
  recommendationOutcome,
} from "../media-origin.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = () =>
  fs.readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** 주석 줄은 세지 않는다 — 규칙을 문서화한 줄까지 위반으로 잡히면 설명을 못 쓴다. */
const isComment = (line: string) => /^\s*(\*|\/\/)/.test(line);

/** 한 파일에서 패턴이 나오는 줄을 찾는다(주석 제외). */
function scan(file: string, pattern: RegExp): string[] {
  const src = fs.readFileSync(path.join(SRC, file), "utf-8");
  const out: string[] = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (isComment(line)) return;
    if (pattern.test(line)) out.push(`${file}:${i + 1}`);
  });
  return out;
}

describe("미디어 목록은 클립만 (FLOWS F2-4)", () => {
  const clips = [{ id: "c1", sourceRecommendationId: "r1" }];
  const recs = [
    { id: "r1", status: "adopted", adoptedClipId: "c1" },
    { id: "r2", status: "pending" },
    { id: "r3", status: "rejected" },
  ];

  it("채택 안 한 추천은 미디어에 없다", () => {
    const media = mediaListFrom({ clips, recommendations: recs });
    assert.deepEqual(media.map((m) => m.id), ["c1"]);
  });

  it("거절한 추천도 미디어에 없다", () => {
    const media = mediaListFrom({ clips, recommendations: recs });
    assert.equal(media.some((m) => m.id === "r3"), false);
  });

  it("추천이 아무리 많아도 클립이 없으면 미디어는 비어 있다", () => {
    // 분석만 끝난 회차 — 추천 12건, 미디어 0건이 정상이다.
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, status: "pending" }));
    assert.deepEqual(mediaListFrom({ clips: [], recommendations: many }), []);
  });

  it("채택된 추천이 미디어를 두 번 만들지 않는다", () => {
    const media = mediaListFrom({ clips, recommendations: recs });
    assert.equal(media.filter((m) => m.id === "c1").length, 1);
  });
});

describe("추천의 판단 상태 — 미결정과 거절은 다르다 (F2 Invariant)", () => {
  it("status 가 없으면 미결정이다 (기본값이 '판단됨'이면 안 된다)", () => {
    assert.equal(isUndecided({ id: "r" }), true);
    assert.equal(recommendationOutcome({ id: "r" }), "undecided");
  });

  it("거절은 판단이 끝난 것 — 미결정이 아니다", () => {
    assert.equal(isUndecided({ id: "r", status: "rejected" }), false);
    assert.equal(recommendationOutcome({ id: "r", status: "rejected" }), "rejected");
  });

  it("status 만 adopted 이고 클립 id 가 없으면 채택으로 치지 않는다", () => {
    // 채택의 증거는 상태 문자열이 아니라 실제로 생긴 미디어다.
    assert.equal(isAdopted({ id: "r", status: "adopted" }), false);
    assert.equal(isAdopted({ id: "r", status: "adopted", adoptedClipId: "c1" }), true);
  });
});

describe("아키텍처 — 미디어를 만드는 경로", () => {
  it("클립 행을 INSERT 하는 곳은 db-pg.ts(commitAdoption) 뿐이다", () => {
    const hits: string[] = [];
    for (const f of sources()) {
      const src = fs.readFileSync(path.join(SRC, f), "utf-8");
      // 여러 줄에 걸친 SQL 이라 파일 단위로 본다: INSERT INTO entities ... 'clip'
      if (/INSERT\s+INTO\s+entities[\s\S]{0,160}?'clip'/i.test(src)) hits.push(f);
    }
    assert.deepEqual(hits, ["db-pg.ts"], `클립을 새로 만드는 경로가 여러 곳이다: ${hits.join(" · ")}`);
  });

  it("채택 트랜잭션을 직접 부르는 곳은 adopt.ts 하나뿐이다", () => {
    // 2026-08-11: index.ts(사람) · factory.ts(공장) 두 벌이던 것을 adopt.ts 로 모았다.
    // 그 전에는 factory 경로가 **이슈 승계를 안 했다** — 경로가 둘이면 한쪽만 고치게 된다.
    const hits = sources()
      .filter((f) => f !== "adopt.ts") // 유일한 정당 호출처
      .flatMap((f) => scan(f, /\bcommitAdoption\s*\(/))
      // db-pg.ts 의 선언부는 호출이 아니다.
      .filter((h) => {
        const [file, line] = h.split(":");
        const text = fs.readFileSync(path.join(SRC, file), "utf-8").split(/\r?\n/)[Number(line) - 1];
        return !/function\s+commitAdoption/.test(text);
      });
    assert.deepEqual(hits, [], `commitAdoption 을 직접 부르는 곳이 생겼다: ${hits.join(" · ")}`);
  });

  // ⚠️ 예전엔 "채택하면 **이슈 승계**가 같이 일어난다" 를 요구했다(F2 Invariant).
  // 권리 게이트가 2026-08-31 에 제거되면서 승계할 대상도 그걸 읽는 소비처도 없어졌다
  // (사용자 결정: "실전에서 필요가 없음" · 근거: rights_issue 0행 · blocked 1건).
  // 남은 불변식은 **채택이 곧 커밋을 거친다**는 것뿐이다.
  it("채택은 커밋을 반드시 거친다", () => {
    const src = fs.readFileSync(path.join(SRC, "adopt.ts"), "utf-8");
    const fn = /export async function commitAndInherit[\s\S]*?\n}/.exec(src)?.[0] ?? "";
    assert.notEqual(fn, "", "commitAndInherit 가 없다");
    assert.match(fn, /commitAdoption\s*\(/, "커밋을 안 한다");
  });

  it("채택 경로는 세 곳뿐이다 — 사람 · 공장 · 자동 배포 규칙", () => {
    const hits = sources()
      .filter((f) => f !== "adopt.ts")
      .flatMap((f) => scan(f, /\bcommitAndInherit\s*\(/));
    const files = [...new Set(hits.map((h) => h.split(":")[0]))].sort();
    assert.deepEqual(
      files,
      ["automation-cycle.ts", "factory.ts", "index.ts"],
      `채택 경로가 달라졌다: ${hits.join(" · ")}`,
    );
  });
});

describe("아키텍처 — 자동 배포 순방은 테넌트 안에서만 돈다", () => {
  it("순방 평가에 시스템 스코프(runAsSystem)가 없다", () => {
    // 시스템 스코프로 돌리면 RLS 가 전 테넌트 행을 보여주고, A 워크스페이스의 규칙이
    // B 의 채널로 나갈 수 있다. 팬아웃(테넌트 목록 읽기)만 워커가 시스템으로 한다.
    const hits = scan("automation-cycle.ts", /runAsSystem|ALL_TENANTS/);
    assert.deepEqual(hits, [], `순방이 테넌트 격리를 벗어난다: ${hits.join(" · ")}`);
  });

  it("순방은 사람이 누르는 배포와 같은 관문을 쓴다", () => {
    const src = fs.readFileSync(path.join(SRC, "automation-cycle.ts"), "utf-8");
    assert.match(src, /dispatchPublish\s*\(/, "관문을 안 지난다");
  });
});
