/**
 * 데스크톱 업데이트 피드 — **아무 객체나 내주지 않는가.**
 *
 * 이 라우트는 세션을 요구하지 않는다(업데이트는 로그인 전에도 받아야 한다). 그래서
 * 이름 검사 하나가 방어의 전부다. 뚫리면 `../` 나 절대경로로 **미디어 버킷의 아무 객체나**
 * 서명 URL 을 받아 갈 수 있다 — 고객 원본 영상이 그 버킷에 있다.
 *
 * 정규식을 복사해 오지 않고 **소스에서 뽑아 그대로 돌린다.** 복사하면 진짜가 바뀐 날
 * 테스트만 옛 규칙을 지키고 통과한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const SRC = path.join(import.meta.dirname, "..");
const INDEX = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8").replace(/\r\n/g, "\n");

/** `desktopObject` 안의 이름 검사 정규식을 소스에서 꺼낸다. */
function nameRegex(): RegExp {
  const fn = INDEX.slice(INDEX.indexOf("function desktopObject("));
  assert.ok(fn.length > 0, "desktopObject 가 사라졌다 — 피드의 방어가 통째로 없어진 것이다");
  const m = /if \(!(\/.+?\/)\.test\(n\)\) return null;/.exec(fn.slice(0, 800));
  assert.ok(m, "이름 검사 정규식을 못 찾았다 — 검사가 사라졌거나 모양이 바뀌었다");
  // 소스에 적힌 그대로를 살려 쓴다.
  const body = m[1]!.slice(1, m[1]!.lastIndexOf("/"));
  return new RegExp(body);
}

describe("피드가 내주는 이름", () => {
  const ok = (n: string) => nameRegex().test(n);

  it("업데이터가 실제로 부르는 이름은 통과한다", () => {
    for (const n of [
      "latest.yml",
      "STEPAISTUDIO-Setup-0.3.0.exe",
      "STEPAISTUDIO-Setup-0.3.0.exe.blockmap",
      "STEPAISTUDIO-0.3.0-full.nupkg.zip",
    ]) {
      assert.equal(ok(n), true, `막지 말아야 할 이름을 막았다: ${n}`);
    }
  });

  it("**경로를 벗어나는 이름은 전부 막는다** — 이 버킷에 고객 원본이 있다", () => {
    for (const n of [
      "../media/secret.mp4",
      "..%2Fmedia%2Fsecret.mp4",
      "a/b.exe",
      "a\\b.exe",
      "/etc/passwd",
      "C:\\Windows\\system32\\config.yml",
      "desktop/latest.yml",
      "....//latest.yml",
    ]) {
      assert.equal(ok(n), false, `경로 탈출을 통과시켰다: ${n}`);
    }
  });

  it("엉뚱한 확장자는 막는다 — 피드는 네 종류만 낸다", () => {
    for (const n of ["latest.txt", "secret.mp4", "dump.sql", "a.exe.mp4", "noext"]) {
      assert.equal(ok(n), false, `통과하면 안 되는 확장자: ${n}`);
    }
  });

  it("이름이 비었거나 확장자만 있으면 막는다", () => {
    for (const n of ["", ".", "..", ".yml", ".exe"]) {
      assert.equal(ok(n), false, `통과하면 안 되는 이름: ${JSON.stringify(n)}`);
    }
  });

  /**
   * `..exe` 는 정규식을 통과한다 — 그리고 **통과해도 된다.** `desktop/..exe` 는 그냥
   * 이상한 이름의 객체일 뿐 상위로 올라가지 않는다(GCS 객체 이름은 경로가 아니다).
   * 여기 적어 두는 이유: 나중에 이걸 "구멍" 으로 착각해 정규식을 조이다가 멀쩡한
   * `STEPAISTUDIO-Setup-0.3.0.exe.blockmap` 을 막는 일이 실제로 잘 일어난다.
   * 위험한 건 **구분자**(`/` `\`)지 점이 아니다 — 그건 위 테스트가 이미 막는다.
   */
  it("점이 여럿인 이름은 위험하지 않다 — 구분자가 없으면 한 조각이다", () => {
    assert.equal(ok("..exe"), true);
    assert.equal(ok("a.b.c.exe"), true);
    // 정말 위험한 것과 구별되는지 같이 확인한다.
    assert.equal(ok("../a.exe"), false);
  });

  it("**항상 접두사가 붙는다** — 이름만으로 버킷 루트를 못 가리킨다", () => {
    const fn = INDEX.slice(INDEX.indexOf("function desktopObject("), INDEX.indexOf("app.get(\"/api/desktop/"));
    assert.match(fn, /return DESKTOP_PREFIX \+ n;/,
      "접두사 없이 객체 경로를 만든다 — 이름 검사만 뚫리면 버킷 전체가 열린다");
    assert.match(INDEX, /const DESKTOP_PREFIX = "desktop\/";/);
  });
});

describe("피드의 응답 규칙", () => {
  it("발행 전에는 404 다 — 5xx 면 업데이터가 오류로 시끄럽게 남긴다", () => {
    const route = INDEX.slice(INDEX.indexOf('app.get("/api/desktop/:file"'));
    assert.match(route.slice(0, 1200), /error: "not_published" \}, 404\)/);
  });

  it("**설치본은 302 로 넘긴다** — 바이트가 Cloud Run 을 지나면 그게 그대로 egress 청구서다", () => {
    const route = INDEX.slice(INDEX.indexOf('app.get("/api/desktop/:file"'));
    const body = route.slice(0, 1600);
    assert.match(body, /return c\.redirect\(await signedReadUrl\(obj/,
      "설치본을 서버가 직접 흘려보낸다 — 100MB 가 매번 Cloud Run 을 지난다");
  });

  it("작은 latest.yml 만 직접 내준다", () => {
    const route = INDEX.slice(INDEX.indexOf('app.get("/api/desktop/:file"'));
    assert.match(route.slice(0, 1600), /obj\.endsWith\("\.yml"\)/);
  });
});

/**
 * **세션 없이 통과하는가.**
 *
 * 라우트를 만들어 놓고 PUBLIC_PATHS 에 안 넣어서 실제 배포에서 401 이 났다. 앱에는
 * 세션이 있을 수 없다 — 업데이트는 로그인 전에도 받아야 하고(로그인 화면이 깨진 버전을
 * 고치는 게 목적일 수 있다), 그 401 은 업데이터에게 "업데이트 없음" 과 구별되지 않는다.
 */
describe("피드는 세션을 요구하지 않는다", () => {
  it("PUBLIC_PATHS 에 들어 있다 — 없으면 401 로 조용히 막힌다", () => {
    const list = INDEX.slice(INDEX.indexOf("const PUBLIC_PATHS"), INDEX.indexOf("function isPublicPath"));
    // 정규식 리터럴 안의 정규식을 또 정규식으로 찾지 않는다 — 이스케이프가 두 겹이 되면
    // 테스트가 헛돌거나 파싱이 깨진다(실제로 한 번 깨졌다). 문자열로 본다.
    assert.ok(list.includes("/api\\/desktop\\/"),
      "PUBLIC_PATHS 에 /api/desktop 이 없다 — 배포하면 앱이 401 만 받는다");
  });

  it("공개 경로는 **파일 하나**까지만 연다 — 하위 경로를 열면 범위가 넓어진다", () => {
    const list = INDEX.slice(INDEX.indexOf("const PUBLIC_PATHS"), INDEX.indexOf("function isPublicPath"));
    assert.ok(list.includes("[^/]+$"),
      "공개 경로가 하위 경로까지 연다 — /api/desktop/a/b 같은 것도 세션 없이 통과한다");
  });
});
