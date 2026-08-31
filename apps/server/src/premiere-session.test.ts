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

/**
 * 사용자가 원한 주 동선(2026-08-28): "편집 끝났으면 원래 내보내기를 누르는데, 그걸 우리 걸로 —
 * 딸깍 누르면 지금 편집창에 떠 있는 그 영상이 렌더돼서 올라가면 좋겠다."
 */
describe("패널 — 활성 시퀀스 렌더 후 업로드", () => {
  it("프리미어를 직접 만진다 — 여기부터가 웹 화면이 아니라 플러그인이다", () => {
    assert.match(panel, /require\("premierepro"\)/);
    assert.match(panel, /getActiveProject/);
    assert.match(panel, /getActiveSequence/);
  });

  it("AME 큐가 아니라 즉시 렌더다 — 큐에 넘기면 언제 끝났는지 몰라 '딸깍' 이 성립하지 않는다", () => {
    assert.match(panel, /immediateExportType/);
    assert.match(panel, /exportSequence\(sequence, immediateExportType\(api\), outPath, PRESET_PATH, true\)/);
  });

  it("`exportFull=true` 를 넘긴다 — 빼면 작업 영역만 나가 '앞부분만 올라갔다' 가 된다", () => {
    assert.match(panel, /PRESET_PATH, true\)/,
      "Adobe 서명: exportSequence(sequence, exportType, outputFile, presetFile, exportFull)");
  });

  it("false 반환을 실패로 읽는다 — 안 보면 0바이트를 업로드하러 간다", () => {
    assert.match(panel, /if \(ok === false\) throw new Error\("프리미어가 내보내기를 거부했습니다/);
  });

  it("렌더 결과는 파일 선택 경로와 **같은 업로드 본체**로 들어간다 — 업로드 로직이 둘이 되면 갈라진다", () => {
    assert.match(panel, /await runUpload\(rendered, selectedProgram\(\)\)/);
    assert.match(panel, /const ok = await runUpload\(picked, selectedProgram\(\)\)/);
  });

  it("빈 렌더 결과를 성공으로 치지 않는다", () => {
    assert.match(panel, /렌더 결과 파일이 비어 있습니다/);
  });

  it("API 이름이 어긋나면 실제 모듈 구성을 콘솔에 쏟는다 — 다음 시도를 추측으로 하지 않으려고", () => {
    assert.match(panel, /function dumpApi\(/);
    assert.match(panel, /Object\.keys\(api\)\.join/);
  });
});

/**
 * 추천 → 시퀀스 마커 (2026-08-31). 공식 선언(@adobe/premierepro 26.3.0)으로 서명을 대조하고 짰다.
 * 이 패키지는 `npm pack @adobe/premierepro` 로 언제든 받아 볼 수 있다 — 추측하지 말 것.
 */
describe("패널 — 추천을 타임라인 마커로", () => {
  it("액션 패턴을 지킨다 — 만들기만 하면 아무 일도 안 일어난다", () => {
    assert.match(panel, /Markers\.getMarkers\(sequence\)/);
    assert.match(panel, /markers\.createAddMarkerAction\(/);
    assert.match(panel, /project\.executeTransaction\(/);
  });

  it("트랜잭션 **하나**에 다 담는다 — Ctrl+Z 한 번으로 전부 되돌리게", () => {
    // for 루프가 executeTransaction 콜백 **안**에 있어야 한다. 밖에 있으면 마커마다
    // 트랜잭션이 하나씩 생겨 되돌리기를 스무 번 눌러야 한다.
    const m = /executeTransaction\(\(compound\) => \{([\s\S]*?)\n  \}, `STEP-D/.exec(panel);
    assert.ok(m, "executeTransaction 블록을 찾지 못했다");
    assert.match(m![1], /for \(const r of recs\)/);
  });

  it("마커에 STEP-D 추천 id 를 남긴다 — 나중에 되짚을 유일한 끈이다", () => {
    assert.match(panel, /`STEP-D \$\{r\.id\}`/);
  });
});

describe("패널 — 내보내기 방식 상수 (조용히 틀리면 안 되는 자리)", () => {
  it("상수를 못 찾으면 **던진다** — 0 으로 폴백하면 AME 큐로 가 버린다", () => {
    // 공식 enum 순서: QUEUE_TO_AME=0 · QUEUE_TO_APP=1 · IMMEDIATELY=2.
    // 예전 코드는 `v === undefined ? 0 : v` 였다 — 즉 폴백이 곧 "AME 큐로 보내기" 였고,
    // 우리는 나오지도 않을 파일을 기다리다 엉뚱한 오류로 죽었을 것이다.
    assert.match(panel, /if \(v === undefined\) \{[\s\S]{0,200}throw new Error\(/);
    assert.doesNotMatch(panel, /v === undefined \? 0 : v/);
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
