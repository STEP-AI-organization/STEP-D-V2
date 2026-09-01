import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listCategories,
  resolveCategory,
  categoryForGenre,
  DEFAULT_CATEGORY,
} from "../naver-categories.ts";
import { genrePackFor } from "../clip-metadata.ts";

describe("네이버 클립 카테고리 — 틀린 분류로 발행되지 않는다", () => {
  it("분류표가 비어 있지 않고, 1차마다 2차가 최소 하나는 있다", () => {
    const cats = listCategories();
    assert.ok(cats.length >= 30, `1차가 ${cats.length}개뿐 — 캡처가 잘렸을 수 있다`);
    for (const c of cats) {
      assert.ok(c.subs.length >= 1, `"${c.name}" 에 2차가 없다 — 2차는 필수값이라 발행이 막힌다`);
    }
  });

  it("정상 조합은 정식 이름으로 확정된다", () => {
    const r = resolveCategory("엔터", "드라마");
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.category, { primary: "엔터", secondary: "드라마" });
  });

  // 사람이 옮겨 적을 때 제일 흔한 차이가 공백이다. 이걸로 발행을 막을 이유는 없다.
  it("공백 차이는 넘어가고, 정식 이름으로 되돌려준다", () => {
    const r = resolveCategory(" 엔터 ", "스타,연예인");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.category.secondary, "스타, 연예인");
  });

  // 실패는 **이유가 화면에 그대로 나가야** 사람이 고칠 수 있다.
  // "알 수 없는 오류" 로 끝나면 뭘 넣어야 하는지 알 방법이 없다.
  it("없는 1차는 거부하고, 고를 수 있는 값을 알려준다", () => {
    const r = resolveCategory("없는분류", "드라마");
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /없는분류/);
    assert.match(r.ok === false ? r.reason : "", /엔터/);
  });

  it("없는 2차는 거부하고, **그 1차의** 2차 목록만 알려준다", () => {
    const r = resolveCategory("엔터", "맛집");   // 맛집은 플레이스의 2차다
    assert.equal(r.ok, false);
    const reason = r.ok === false ? r.reason : "";
    assert.match(reason, /드라마/, "엔터의 2차 목록이 나와야 한다");
    assert.doesNotMatch(reason, /맛집.*·.*카페/, "남의 1차 목록을 흘리면 안 된다");
  });

  // ⚠️ 이게 깨지면 **카테고리를 지정하지 않은 모든 발행이 실패한다.**
  // 기본값은 표를 통과해야만 기본값 노릇을 한다.
  it("기본값은 그 자체로 표에 있는 값이다", () => {
    assert.equal(resolveCategory(DEFAULT_CATEGORY.primary, DEFAULT_CATEGORY.secondary).ok, true);
  });

  it("장르가 유도한 카테고리도 전부 표에 있다", () => {
    for (const g of ["드라마", "drama", "예능", "variety", "영화", "", "시사교양", undefined]) {
      const cat = categoryForGenre(g);
      const r = resolveCategory(cat.primary, cat.secondary);
      assert.equal(r.ok, true, `장르 "${g}" → ${cat.primary}/${cat.secondary} 가 표에 없다`);
    }
  });

  it("드라마·예능은 각자 제 칸으로 간다", () => {
    assert.equal(categoryForGenre("드라마").secondary, "드라마");
    assert.equal(categoryForGenre("variety").secondary, "예능");
    assert.deepEqual(categoryForGenre("시사교양"), DEFAULT_CATEGORY);
  });

  // ── 소스 스캔 ──────────────────────────────────────────────────────────────
  // 순수 함수로는 증명 못 하는 불변식이다: **카테고리를 정하는 곳은 한 군데여야 한다.**
  // 자동배포가 `엔터/엔터` 를 박아 넘기던 시절엔, 프로그램에 카테고리를 정해 둬도
  // 자동 경로는 늘 무시했다(페이로드가 프로그램 기본값을 이기니까). 코드를 읽어서는
  // 안 보이고, 발행된 클립을 네이버에서 봐야만 알 수 있는 종류의 버그다.
  it("자동배포는 카테고리를 박아 넘기지 않는다 — 워커가 프로그램·장르로 푼다", () => {
    const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(path.join(here, "automation-cycle.ts"), "utf8");
    const hardcoded = src.match(/naverCategory\s*:\s*\{[^}]*primary/);
    assert.equal(
      hardcoded, null,
      "automation-cycle.ts 가 naverCategory 를 리터럴로 넘긴다 — 그러면 프로그램 설정이 무시된다. " +
      "안 넘기면 워커가 프로그램 기본값 → 장르 순으로 푼다.",
    );
  });

  // 제목 톤(장르팩)과 카테고리가 어긋나면 "제목은 드라마인데 분류는 예능" 이 된다.
  // 두 곳이 같은 문자열 규칙을 쓰는지 여기서 고정한다.
  it("장르 판정이 clip-metadata 의 장르팩과 어긋나지 않는다", () => {
    for (const [g, sub] of [["드라마", "드라마"], ["drama", "드라마"], ["예능", "예능"], ["variety", "예능"]] as const) {
      assert.equal(genrePackFor(g).label, sub, `장르팩이 "${g}" 를 ${sub} 로 안 본다`);
      assert.equal(categoryForGenre(g).secondary, sub, `카테고리가 "${g}" 를 ${sub} 로 안 본다`);
    }
  });
});
