/**
 * "+(채택)를 눌러야 미디어에 뜬다" 고정 (FLOWS F2).
 *
 * 이 파일의 마지막 두 테스트가 핵심이다. 순수 함수 테스트는 "이 함수는 추천을 안 섞는다"
 * 까지만 증명한다 — 다른 파일이 클립을 새로 만들어 버리면 그만이다. 그래서 소스를 스캔해
 * **클립 행을 INSERT 하는 지점이 한 곳뿐**임을 강제한다.
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
} from "./media-origin.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const sources = () =>
  fs.readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

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

describe("아키텍처 — 미디어를 만드는 경로가 하나여야 한다", () => {
  it("클립 행을 INSERT 하는 곳은 db-pg.ts(commitAdoption) 뿐이다", () => {
    const hits: string[] = [];
    for (const f of sources()) {
      const src = fs.readFileSync(path.join(SRC, f), "utf-8");
      // 여러 줄에 걸친 SQL 이라 파일 단위로 본다: INSERT INTO entities ... 'clip'
      const re = /INSERT\s+INTO\s+entities[\s\S]{0,160}?'clip'/gi;
      if (re.test(src)) hits.push(f);
    }
    assert.deepEqual(
      hits,
      ["db-pg.ts"],
      `클립을 새로 만드는 경로가 여러 곳이다: ${hits.join(" · ")}`,
    );
  });

  it("채택 트랜잭션 호출처는 알려진 두 곳뿐이다 (사람의 채택 · 자동 배포 규칙)", () => {
    const hits: string[] = [];
    for (const f of sources()) {
      if (f === "db-pg.ts") continue; // 정의부
      const src = fs.readFileSync(path.join(SRC, f), "utf-8");
      src.split("\n").forEach((line, i) => {
        if (/\bcommitAdoption\s*\(/.test(line)) hits.push(`${f}:${i + 1}`);
      });
    }
    // 늘어나면 테스트가 깨진다 — 새 채택 경로는 눈에 보이는 결정이어야 한다.
    assert.equal(
      hits.length,
      2,
      `채택 경로가 ${hits.length}곳이다: ${hits.join(" · ")}`,
    );
    assert.equal(hits.some((h) => h.startsWith("index.ts")), true, "사람이 누르는 경로");
    assert.equal(hits.some((h) => h.startsWith("factory.ts")), true, "자동 배포 규칙 경로");
  });
});
