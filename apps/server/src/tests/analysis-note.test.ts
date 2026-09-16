/**
 * 분석 결과 한 줄(`episode.pipeline.note`).
 *
 * 이 테스트가 존재하는 이유는 **재분석**이다. 사람이 추천을 다 채택한 회차를 다시 분석하면
 * `writeRecommendationsFromShorts` 가 이미 처리한 구간을 걸러내 `wrote = 0` 이 되는데,
 * 예전 코드는 그걸 "분석 완료 · 추천 없음" 으로 적었다 — 멀쩡한 회차가 화면에서 실패처럼
 * 보였다(2026-09-16 · ENA 나미브 18회차에서 실제로 그랬다).
 *
 * 값이 틀리는 종류의 버그라 순수 함수로 고정한다(CLAUDE.md "컨벤션 — 검증을 어디에 넣는가").
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analysisNote } from "../pipeline/analysis-note.ts";

describe("분석 결과 문구", () => {
  it("새 추천이 나오면 그 개수를 적는다", () => {
    assert.equal(analysisNote(9, 0), "AI 쇼츠 추천 9건");
    // 이미 처리된 게 있어도 **새로 나온 게 있으면** 그쪽이 우선이다 — 운영자가 볼 일은 새것이다.
    assert.equal(analysisNote(3, 5), "AI 쇼츠 추천 3건");
  });

  it("**재분석에서 새 추천이 0 이어도 기존이 있으면 '추천 없음' 이 아니다**", () => {
    // 이게 이 파일의 존재 이유다. 두 상태는 운영자가 할 일이 정반대다:
    //   추천 없음     → 쓸 게 안 나왔다. 원본을 의심하거나 다른 회차를 본다.
    //   새 추천 없음  → 이미 다 뽑아 썼다. 할 일이 없다는 뜻이고 정상이다.
    const note = analysisNote(0, 3);
    assert.equal(note, "분석 완료 · 새 추천 없음 (기존 3건 처리됨)");
    assert.equal(/^분석 완료 · 추천 없음$/.test(note), false, "예전 문구로 되돌아갔다");
  });

  it("처음부터 아무것도 안 나오면 '추천 없음' 이다", () => {
    assert.equal(analysisNote(0, 0), "분석 완료 · 추천 없음");
  });

  it("**'크레딧'·'충전' 을 넣지 않는다** — automation 이 그 낱말로 막힘 판정을 한다", () => {
    // `episodeAnalysisState` 는 note 에서 /크레딧|충전/ 을 찾으면 "크레딧 부족으로 막힘" 으로
    // 본다. 분석 결과 문구에 그 말이 섞이면 멀쩡히 끝난 회차가 자동배포에서 막힌 것으로 잡힌다.
    for (const [w, k] of [[0, 0], [0, 3], [7, 0], [7, 3]] as const) {
      assert.equal(/크레딧|충전/.test(analysisNote(w, k)), false, `analysisNote(${w}, ${k})`);
    }
  });
});
