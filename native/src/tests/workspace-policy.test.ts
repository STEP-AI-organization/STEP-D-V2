/**
 * 관리형 작업 공간 — **순수 판정 테스트.** 디스크를 안 만든다.
 *
 * 여기서 틀리면 두 방향으로 사고가 난다:
 *   · 밖의 파일을 안이라고 판정 → 이 설계 전체가 무의미해진다
 *   · 멀쩡한 파일을 거절       → 편집자가 일을 못 한다
 * 둘 다 fs 없이 확인할 수 있어야 한다.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_POLICY, MAX_PATH, WORKSPACE_FOLDERS,
  clampSegment, extensionAllowed, isInsideRoot, pathTooLong, resolveFolder, safeSegment,
} from "../workspace/policy.js";

describe("이름 정규화", () => {
  it("한글은 NFC 로 모은다 — macOS 를 거친 파일명이 자모로 쪼개져 온다", () => {
    // "회차" 를 NFD(자모 분리)로 만든 것. 정규화 없이 비교하면 같은 회차가 폴더 둘이 된다.
    const nfd = "회차".normalize("NFD");
    assert.notEqual(nfd, "회차", "표본이 이미 NFC 면 이 테스트가 아무것도 안 본다");
    assert.equal(safeSegment(nfd), "회차");
  });

  it("경로로 새는 문자를 막는다", () => {
    assert.equal(safeSegment("a/b\\c:d*e?f"), "a b c d e f");
  });

  it("점만 있는 이름은 이름이 아니다", () => {
    assert.equal(safeSegment("."), "무제");
    assert.equal(safeSegment(".."), "무제");
  });

  it("**상위로 못 올라간다** — 문자열이 아니라 결과 경로로 확인한다", () => {
    // 이름에 '..' 이 남는 것 자체는 무해하다(구분자가 없으면 한 조각일 뿐이다).
    // 지켜야 하는 건 "합쳐진 경로가 루트 안" 이라는 사실이고, 그걸 직접 본다.
    const root = path.resolve("C:/WS");
    for (const evil of ["../../etc", "..\\..\\windows", "..", "./../x"]) {
      const dir = resolveFolder(root, { program: evil, folder: "source" });
      assert.equal(isInsideRoot(root, dir, true), true, `루트를 벗어났다: ${evil} → ${dir}`);
    }
  });

  it("Windows 예약어는 그대로 쓰지 않는다 — 확장자가 붙어도 예약이다", () => {
    assert.equal(safeSegment("CON"), "_CON");
    assert.equal(safeSegment("con.mp4"), "_con.mp4");
    assert.equal(safeSegment("NUL"), "_NUL");
    // 예약어로 시작할 뿐인 멀쩡한 이름은 건드리지 않는다.
    assert.equal(safeSegment("CONCERT"), "CONCERT");
  });

  it("후행 점·공백을 없앤다 — Windows 가 조용히 잘라 이름이 어긋난다", () => {
    assert.equal(safeSegment("회차1. "), "회차1");
    assert.equal(safeSegment("이름   "), "이름");
  });

  it("전부 걸러져도 빈 이름을 만들지 않는다", () => {
    assert.equal(safeSegment("///"), "무제");
    assert.equal(safeSegment(""), "무제");
    assert.equal(safeSegment("   ", "폴백"), "폴백");
  });

  it("길이를 자르되 자른 끝에 점·공백을 남기지 않는다", () => {
    const long = "가".repeat(200);
    assert.equal(clampSegment(long).length, 60);
    assert.equal(clampSegment("가".repeat(59) + ". ", 60), "가".repeat(59));
  });
});

describe("경로 해석", () => {
  const ROOT = path.resolve("C:/WS");

  it("프로그램 · 회차 · 폴더 순서로 쌓는다", () => {
    const p = resolveFolder(ROOT, { program: "폭간트", episode: "12회", folder: "source" });
    assert.equal(p, path.join(ROOT, "폭간트", "12회", "source"));
  });

  it("회차가 없으면 프로그램 바로 아래다", () => {
    const p = resolveFolder(ROOT, { program: "폭간트", folder: "export" });
    assert.equal(p, path.join(ROOT, "폭간트", "export"));
  });

  it("빈 회차 문자열은 없는 것과 같다 — 빈 폴더를 만들지 않는다", () => {
    const p = resolveFolder(ROOT, { program: "폭간트", episode: "   ", folder: "source" });
    assert.equal(p, path.join(ROOT, "폭간트", "source"));
  });

  it("표준 폴더는 다섯이고 순서가 화면 순서다", () => {
    assert.deepEqual([...WORKSPACE_FOLDERS], ["source", "proxy", "project", "export", "delivery"]);
  });

  it("경로 상한을 넘으면 알린다 — 자르지 않는다(다른 회차가 겹친다)", () => {
    assert.equal(pathTooLong(path.join(ROOT, "a")), false);
    assert.equal(pathTooLong("C:/" + "a".repeat(MAX_PATH)), true);
  });
});

describe("루트 안인가 — 문자열 비교의 함정", () => {
  const ROOT = path.resolve("C:/WS");

  it("하위 경로는 안이다", () => {
    assert.equal(isInsideRoot(ROOT, path.join(ROOT, "프로그램", "source", "a.mp4"), true), true);
  });

  it("**접두사가 같을 뿐인 형제는 밖이다** — 구분자까지 봐야 한다", () => {
    // 이걸 못 잡으면 공격자가 옆에 'WS-evil' 을 만들어 통째로 통과시킨다.
    assert.equal(isInsideRoot(ROOT, path.resolve("C:/WS-evil/a.mp4"), true), false);
    assert.equal(isInsideRoot(ROOT, path.resolve("C:/WSx"), true), false);
  });

  it("루트 자신은 안이 아니다 — 루트에 파일을 바로 두지 않는다", () => {
    assert.equal(isInsideRoot(ROOT, ROOT, true), false);
  });

  it("Windows 는 대소문자를 안 가린다", () => {
    assert.equal(isInsideRoot("C:/WS", "C:/ws/a/b.mp4", true), true);
    // 가리는 플랫폼에서는 다르게 판정해야 한다.
    assert.equal(isInsideRoot("/ws", "/WS/a", false), false);
  });

  it("상위로 올라가는 경로는 밖이다", () => {
    assert.equal(isInsideRoot(ROOT, path.join(ROOT, "..", "secret.mp4"), true), false);
  });
});

describe("정책", () => {
  it("확장자 목록이 비면 판정하지 않는다 — 호출부가 영상 목록을 본다", () => {
    assert.equal(extensionAllowed(DEFAULT_POLICY, "a.zip"), true);
  });

  it("목록이 있으면 그것만 받는다 (대소문자 무시)", () => {
    const p = { ...DEFAULT_POLICY, allowedExtensions: [".mp4", ".mov"] };
    assert.equal(extensionAllowed(p, "a.MP4"), true);
    assert.equal(extensionAllowed(p, "a.zip"), false);
  });

  it("기본 정책은 자동 들여오기가 켜져 있다 — 꺼진 채로 배포되면 아무도 못 올린다", () => {
    assert.equal(DEFAULT_POLICY.autoImportExternal, true);
    assert.equal(DEFAULT_POLICY.rootDirName, "STEP-D Workspace");
  });
});
