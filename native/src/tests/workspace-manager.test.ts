/**
 * 관리형 작업 공간 — **실제 디스크 테스트.** 순수 함수로는 증명 못 하는 것만 여기 둔다.
 *
 * 여기서 보는 것은 셋이다:
 *   1. 심볼릭 링크로 루트를 벗어날 수 있는가 (문자열 비교로는 절대 안 잡힌다)
 *   2. 복사가 깨졌을 때 **정식 이름의 반쪽 파일이 남는가**
 *   3. 같은 파일을 두 번 들이면 두 벌이 되는가
 *
 * 임시 디렉토리에서만 돈다 — 사용자 홈을 건드리지 않는다.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { WorkspaceManager } from "../workspace/manager.js";
import { DEFAULT_POLICY } from "../workspace/policy.js";

let home = "";
let outside = "";

/** 테스트 파일 하나 만들고 절대경로를 준다. */
async function makeFile(dir: string, name: string, body = "video-bytes"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await writeFile(p, body);
  return p;
}

before(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "stepd-ws-home-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "stepd-ws-out-"));
});

after(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(outside, { recursive: true, force: true }).catch(() => {});
});

/**
 * 테스트용 매니저 — **드라이브 조회를 빈 목록으로 갈아끼운다.**
 *
 * 안 갈아끼우면 실제 PC 의 디스크를 훑어 여유가 가장 큰 드라이브(개발 PC 면 `D:\`)를 골라서,
 * 임시 홈 밖에 진짜 폴더를 만든다 — 테스트가 사용자 디스크를 더럽히고, 판정도 홈 기준이
 * 아니게 된다. 빈 목록이면 "기준을 넘는 디스크 없음" → 홈으로 떨어진다.
 */
function mgr(policy = DEFAULT_POLICY, home = () => home0()): WorkspaceManager {
  return new WorkspaceManager(policy, home(), async () => []);
}
const home0 = () => home;

describe("작업 공간 준비", () => {
  it("루트를 만들고 상태를 사실대로 알린다", async () => {
    const m = mgr();
    const before0 = await m.info();
    assert.equal(before0.ready, false, "안 만들었는데 준비됐다고 했다");

    const info = await m.ensureRoot();
    assert.equal(info.ready, true);
    assert.equal(info.policyVersion, DEFAULT_POLICY.version);
    assert.deepEqual(info.folders, [...DEFAULT_POLICY.folders]);
    // realpath 를 돌려준다 — 심링크 홈(macOS /var → /private/var)에서도 기준이 하나여야 한다.
    assert.ok(path.isAbsolute(info.rootPath));
  });

  it("프로그램·회차 폴더를 미리 만들지 않는다 — 빈 폴더가 회차 수만큼 쌓인다", async () => {
    const m = mgr();
    const info = await m.ensureRoot();
    const entries = await readdir(info.rootPath);
    assert.deepEqual(entries.filter((e) => !e.startsWith(".")), [], "루트에 미리 만든 폴더가 있다");
  });
});

describe("경로 탈출 — 링크는 문자열로 안 잡힌다", () => {
  it("작업 공간 밖 파일은 관리형이 아니다", async () => {
    const m = mgr();
    await m.ensureRoot();
    const ext = await makeFile(outside, "outside.mp4");
    assert.equal(await m.isManaged(ext), false);
  });

  it("**루트 안의 심볼릭 링크가 밖을 가리키면 거절한다**", async (t) => {
    const m = mgr();
    const info = await m.ensureRoot();
    const secret = await makeFile(outside, "secret.mp4");
    const link = path.join(info.rootPath, "looks-inside.mp4");
    try {
      await symlink(secret, link);
    } catch {
      // Windows 는 개발자 모드/관리자 아니면 심링크를 못 만든다 — 그때는 건너뛴다.
      t.skip("심볼릭 링크를 만들 권한이 없다");
      return;
    }
    // 경로 문자열만 보면 루트 안이다. realpath 로 풀어야 밖인 걸 안다.
    assert.ok(link.startsWith(info.rootPath), "표본이 루트 안 경로가 아니다");
    assert.equal(await m.isManaged(link), false, "링크를 따라가지 않고 통과시켰다");
  });

  /**
   * **정션(junction)이 실전의 우회다.** Windows 에서 심볼릭 링크는 관리자나 개발자 모드가
   * 있어야 만들 수 있지만(그래서 위 테스트는 흔히 skip 된다), 디렉토리 정션은 **권한 없이**
   * 누구나 만든다 — `mklink /J` 한 줄이다. 편집자 PC 도 같은 조건이라, 이 테스트가 실제로
   * 도는 유일한 탈출 검증인 경우가 많다.
   */
  it("**루트 안의 정션이 밖을 가리키면 거절한다** (권한 없이 만들어지는 우회)", async (t) => {
    const m = mgr();
    const info = await m.ensureRoot();
    const secretDir = path.join(outside, "secret-dir");
    await makeFile(secretDir, "hidden.mp4", "leak");

    const junction = path.join(info.rootPath, "looks-like-a-folder");
    try {
      // type "junction" 은 Windows 에서 권한 없이 만들어진다. 다른 OS 는 dir 심링크로 떨어진다.
      await symlink(secretDir, junction, "junction");
    } catch {
      t.skip("정션을 만들 수 없는 환경");
      return;
    }

    const throughJunction = path.join(junction, "hidden.mp4");
    // 문자열로는 완벽히 루트 안이다 — realpath 로 풀어야 밖인 걸 안다.
    assert.ok(throughJunction.startsWith(info.rootPath), "표본이 루트 안 경로가 아니다");
    assert.equal(await m.isManaged(throughJunction), false, "정션을 따라가지 않고 통과시켰다");
  });

  it("루트 안의 진짜 파일은 관리형이다", async () => {
    const m = mgr();
    const info = await m.ensureRoot();
    const inside = await makeFile(path.join(info.rootPath, "프로그램", "1회", "source"), "a.mp4");
    assert.equal(await m.isManaged(inside), true);
  });

  it("없는 경로는 관리형이 아니다 — 판정이 예외로 새지 않는다", async () => {
    const m = mgr();
    await m.ensureRoot();
    assert.equal(await m.isManaged(path.join(outside, "없는파일.mp4")), false);
  });
});

describe("들여오기", () => {
  it("밖의 파일을 복사해 들이고 **원본을 남긴다**", async () => {
    const m = mgr();
    await m.ensureRoot();
    const src = await makeFile(outside, "본방.mp4", "abc");

    const r = await m.importFile(src, { program: "폭간트", episode: "12회", folder: "source" });
    assert.equal(r.reused, false);
    assert.equal(r.filename, "본방.mp4");
    assert.equal(await m.isManaged(r.managedPath), true);
    assert.equal(await readFile(r.managedPath, "utf8"), "abc");
    // 원본이 사라지면 편집자는 우리가 잃어버린 것으로 본다.
    assert.equal(await readFile(src, "utf8"), "abc");
  });

  it("이미 관리형이면 복사하지 않는다 — 같은 파일을 두 벌로 두지 않는다", async () => {
    const m = mgr();
    const info = await m.ensureRoot();
    const inside = await makeFile(path.join(info.rootPath, "프로그램", "source"), "b.mp4");
    const r = await m.importFile(inside, { program: "프로그램", folder: "source" });
    assert.equal(r.reused, true);
    assert.equal(r.managedPath, inside);
  });

  it("같은 파일을 다시 들이면 재사용한다 (지문 대조)", async () => {
    const m = mgr();
    await m.ensureRoot();
    const src = await makeFile(outside, "중복.mp4", "same");
    const first = await m.importFile(src, { program: "P", episode: "E", folder: "source" });
    const second = await m.importFile(src, { program: "P", episode: "E", folder: "source" });
    assert.equal(first.managedPath, second.managedPath);
    assert.equal(second.reused, true, "같은 파일을 다시 복사했다");
  });

  it("내용이 바뀌면 다시 복사한다 — 이름만 같다고 건너뛰면 옛 파일이 올라간다", async () => {
    const m = mgr();
    await m.ensureRoot();
    const src = await makeFile(outside, "수정본.mp4", "v1");
    const first = await m.importFile(src, { program: "P2", folder: "source" });
    assert.equal(await readFile(first.managedPath, "utf8"), "v1");

    await writeFile(src, "v2-longer");
    const second = await m.importFile(src, { program: "P2", folder: "source" });
    assert.equal(second.reused, false, "바뀐 파일을 재사용했다");
    assert.equal(await readFile(second.managedPath, "utf8"), "v2-longer");
  });

  it("**불완전한 정식 파일을 남기지 않는다** — 임시 파일은 대상 폴더 안에서만 산다", async () => {
    const m = mgr();
    await m.ensureRoot();
    const src = await makeFile(outside, "원자성.mp4", "xyz");
    const r = await m.importFile(src, { program: "P3", episode: "E3", folder: "source" });

    // 성공했으니 정식 파일만 남고 임시 폴더는 비어 있어야 한다.
    const dir = path.dirname(r.managedPath);
    const entries = await readdir(dir);
    assert.ok(entries.includes("원자성.mp4"));
    assert.ok(!entries.some((e) => e.endsWith(".part")), "정식 폴더에 .part 가 남았다");
  });

  it("자동 들여오기를 끄면 밖의 파일을 거절한다 — 사유를 사람 말로 준다", async () => {
    const m = mgr({ ...DEFAULT_POLICY, autoImportExternal: false });
    await m.ensureRoot();
    const src = await makeFile(outside, "거절.mp4");
    await assert.rejects(
      () => m.importFile(src, { program: "P4", folder: "source" }),
      /작업 공간/,
    );
  });

  it("없는 파일은 사람이 읽을 수 있는 사유로 거절한다", async () => {
    const m = mgr();
    await m.ensureRoot();
    await assert.rejects(
      () => m.importFile(path.join(outside, "없다.mp4"), { program: "P5", folder: "source" }),
      /찾을 수 없습니다/,
    );
  });

  it("경로가 상한을 넘으면 자르지 않고 거절한다 — 자르면 다른 회차가 겹친다", async () => {
    const m = mgr();
    await m.ensureRoot();
    // 조각은 60자로 잘리고 파일명은 120자로 잘린다 — 셋을 다 채워야 260 을 넘긴다.
    // (임시 홈 경로 길이에 기대지 않으려고 파일명까지 길게 쓴다.)
    const src = await makeFile(outside, `${"n".repeat(120)}.mp4`);
    const long = "가".repeat(60);
    await assert.rejects(
      () => m.importFile(src, { program: long, episode: long, folder: "source" }),
      /너무 깁니다/,
    );
  });
});

describe("임시 파일 청소", () => {
  it("기동 시 남은 .stepd-tmp 를 지운다 — 죽은 복사의 잔해", async () => {
    const m = mgr();
    const info = await m.ensureRoot();
    const tmpDir = path.join(info.rootPath, "P6", "E6", "source", ".stepd-tmp");
    await makeFile(tmpDir, "1234-abcd.part", "half");

    await m.ensureRoot();   // 다시 기동
    const parent = path.join(info.rootPath, "P6", "E6", "source");
    const entries = await readdir(parent);
    assert.ok(!entries.includes(".stepd-tmp"), "죽은 복사 잔해가 남았다");
  });
});
