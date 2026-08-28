/**
 * 프리미어 패널이 기대는 **인증 표면**을 고정한다.
 *
 * 왜 테스트가 필요한가: 이 두 줄은 웹에서 아무 일도 하지 않는다(웹은 쿠키로 붙는다).
 * 그래서 나중에 누군가 "쿠키만 쓰면 되는데 왜 헤더도 보지?" 하고 지우면 **웹은 멀쩡한 채
 * 프리미어 패널만 조용히 로그인 불가**가 된다 — 서버 테스트가 다 초록인 상태로.
 * 그 조용한 실패를 여기서 막는다.
 *
 * UXP 는 브라우저가 아니라 쿠키 저장소가 없다(fetch 가 Set-Cookie 를 보관·재전송하지 않음).
 * 그래서 같은 세션 토큰을 헤더로도 받는다 — 새 자격증명 체계가 아니라 **같은 세션의 다른 운반**이다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SRC, "../../..");
const read = (p: string) => fs.readFileSync(path.resolve(REPO, p), "utf-8");

const index = read("apps/server/src/index.ts");
const panel = read("packages/premiere/main.js");
const manifest = JSON.parse(read("packages/premiere/manifest.json"));

describe("세션 토큰의 두 번째 운반 (x-stepd-session)", () => {
  it("쿠키와 헤더를 한 곳에서 읽는다 — 검증 경로는 resolveSession 하나", () => {
    assert.match(index, /function sessionToken\(c: Context<AppEnv>\)/);
    assert.match(index, /getCookie\(c, SESSION_COOKIE\) \?\? c\.req\.header\("x-stepd-session"\)/);
    assert.match(index, /resolveSession\(sessionToken\(c\)\)/);
  });

  it("쿠키가 먼저다 — 헤더가 브라우저 세션을 가로채지 못한다", () => {
    const line = /getCookie\(c, SESSION_COOKIE\) \?\? c\.req\.header\("x-stepd-session"\)/.exec(index);
    assert.ok(line, "우선순위가 바뀌면 위조 헤더가 로그인된 쿠키를 덮을 수 있다");
  });

  it("로그아웃·전체 로그아웃도 같은 토큰을 본다 — 헤더 세션이 안 끊기면 안 된다", () => {
    assert.match(index, /destroySession\(sessionToken\(c\)\)/);
    assert.match(index, /destroyAllSessions\(user\.id, sessionToken\(c\)\)/);
  });

  it("토큰은 x-stepd-client 를 보낸 호출자에게만 응답에 실린다 — 웹 응답은 그대로(HttpOnly 유지)", () => {
    assert.match(index, /if \(\(c\.req\.header\("x-stepd-client"\) \?\? ""\)\.trim\(\)\) \{\s*\n\s*out\.token = token;/);
    assert.match(index, /setCookie\(c, SESSION_COOKIE, token, sessionCookieOpts\(expiresAt\)\)/,
      "쿠키 설정을 없애면 웹 로그인이 깨진다 — 헤더는 추가지 대체가 아니다");
  });
});

describe("패널 — 만료 시 자동 재인증", () => {
  it("401 이면 재로그인 후 **한 번만** 재시도한다 (비밀번호가 바뀌면 로그인도 401 → 루프 방지)", () => {
    assert.match(panel, /if \(res\.status === 401 && allowRetry\) \{[\s\S]{0,200}return api\(path, init, false\);/);
  });

  it("자격증명은 OS 키체인(secureStorage)에만 둔다 — 평문 파일 금지", () => {
    assert.match(panel, /uxp\.storage\.secureStorage/);
    assert.doesNotMatch(panel, /localStorage/, "localStorage 는 평문이다");
  });

  it("업로드가 끝난 뒤의 clip-finalize 도 같은 api() 를 지난다 — 여기서 401 이면 30분을 버린다", () => {
    assert.match(panel, /apiJson\("\/media\/clip-finalize"/);
  });
});

describe("패널 — 업로드 경로 (서버 API 를 복제하지 않는다)", () => {
  it("웹과 같은 3단계를 그대로 탄다", () => {
    assert.match(panel, /apiJson\("\/media\/upload-init"/);
    assert.match(panel, /putChunk\(sessionUrl/);
    assert.match(panel, /apiJson\("\/media\/clip-finalize"/);
  });

  it("청크는 XHR 로 보낸다 — fetch 는 308(Resume Incomplete)을 삼켜 이어받기가 깨진다", () => {
    assert.match(panel, /new XMLHttpRequest\(\)[\s\S]{0,200}Content-Range/);
    assert.match(panel, /res\.status === 308/);
  });

  it("끊기면 GCS 가 받은 위치를 되물어 재개한다 — 우리 offset 은 진실이 아니다", () => {
    assert.match(panel, /queryCommitted\(sessionUrl, total\)/);
    assert.match(panel, /bytes \*\/\$\{total\}/);
  });
});

describe("패널 매니페스트", () => {
  it("UXP manifest v5 · Premiere 25.6+ (UXP 정식 지원 시작 버전)", () => {
    assert.equal(manifest.manifestVersion, 5);
    assert.equal(manifest.host[0].app, "premierepro");
    assert.equal(manifest.host[0].minVersion, "25.6.0");
  });

  it("네트워크는 STEP-D 와 GCS 둘뿐 · 파일 접근은 request — 심사도 이 좁기를 본다", () => {
    assert.deepEqual(manifest.requiredPermissions.network.domains,
      ["https://stepd.stepai.kr", "https://storage.googleapis.com"]);
    assert.equal(manifest.requiredPermissions.localFileSystem, "request");
  });

  it("플러그인 ID 는 마켓플레이스 등록 후 못 바꾼다 — 지금 값으로 고정", () => {
    assert.equal(manifest.id, "kr.stepai.stepd.premiere");
  });
});
