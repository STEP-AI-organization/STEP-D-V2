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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    assert.match(panel, /await runUpload\(rendered, selectedProgram\(\), context\)/);
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
    assert.match(panel, /lockedTransaction\(project, /);
  });

  it("트랜잭션 **하나**에 다 담는다 — Ctrl+Z 한 번으로 전부 되돌리게", () => {
    // for 루프가 executeTransaction 콜백 **안**에 있어야 한다. 밖에 있으면 마커마다
    // 트랜잭션이 하나씩 생겨 되돌리기를 스무 번 눌러야 한다.
    const m = /lockedTransaction\(project, \(compound\) => \{([\s\S]*?)\n  \}, `STEP-D/.exec(panel);
    assert.ok(m, "트랜잭션 블록을 찾지 못했다");
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

/**
 * 웹 → 프리미어 핸드오프 (2026-08-31 사용자 요구: "웹에서 편집 누르면 딱 프리미어 켜지게").
 *
 * 왜 이런 모양인가: **브라우저가 실행 중인 UXP 패널에 값을 직접 건넬 방법이 없다.**
 * UXP 의 launchProcess 는 패널→OS 방향뿐이고 반대는 없다(Adobe 문서 확인). 그래서
 * **실행은 `stepd://` 스킴, 맥락은 서버 경유(폴링)** 로 나눴다.
 */
describe("웹 → 프리미어 핸드오프", () => {
  it("남기기·집어가기 두 라우트가 있다", () => {
    assert.match(index, /app\.post\("\/api\/premiere\/handoff"/);
    assert.match(index, /app\.get\("\/api\/premiere\/handoff"/);
  });

  it("**한 번만** 소비된다 — 안 지우면 폴링할 때마다 같은 회차로 계속 끌려간다", () => {
    assert.match(index, /await setAutomationSetting\(premiereHandoffKey\(user\.id\), ""\);/);
  });

  it("오래된 핸드오프는 버린다 — 어제 누른 게 오늘 패널에서 튀어나오면 안 된다", () => {
    assert.match(index, /HANDOFF_TTL_MS_PREMIERE/);
    assert.match(index, /Date\.now\(\) - Number\(h\.at \?\? 0\) > HANDOFF_TTL_MS_PREMIERE/);
  });

  it("사용자별로 나뉜다 — 남의 핸드오프를 집어가면 안 된다", () => {
    assert.match(index, /premiereHandoffKey = \(userId: string\)/);
    assert.match(index, /const user = requireUser\(c\);/);
  });

  it("빈 요청은 400 — 뭘 열지 모르는 핸드오프는 만들지 않는다", () => {
    assert.match(index, /programId·episodeId·clipId·mediaId 중 하나는 필요합니다/);
  });

  it("패널은 작업 중에 폴링하지 않는다 — 업로드·렌더 화면이 가려진다", () => {
    assert.match(panel, /if \(busy \|\| !session\.token\) return;/);
  });

  it("웹은 **남기고 나서** 앱을 띄운다 — 순서가 바뀌면 패널이 빈손으로 깨어난다", () => {
    const api = read("apps/web/src/lib/data/api.ts");
    const postAt = api.indexOf("/premiere/handoff");
    const launchAt = api.indexOf('window.location.href = "stepd://open"');
    assert.ok(postAt > 0 && launchAt > 0, "핸드오프 함수를 찾지 못했다");
    assert.ok(postAt < launchAt, "앱을 먼저 띄우면 맥락이 아직 서버에 없다");
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

/**
 * 추천 → 서브클립 (2026-08-31). 마커는 "여기가 좋다" 까지고, 서브클립은 **이미 잘라 놓은
 * 조각**을 준다 — 편집자는 끌어다 놓기만 하면 된다. 러프컷 시퀀스 조립의 재료이기도 하다.
 * 서명은 공식 선언(@adobe/premierepro 26.3.0)으로 대조했다.
 */
describe("패널 — 추천 구간을 서브클립으로", () => {
  it("원본을 **파일명으로** 찾는다 — 경로는 PC 마다 다르다", () => {
    assert.match(panel, /async function findMasterItem\(filename, use\)/);
    assert.match(panel, /getMediaFilePath\(\)/);
    assert.match(panel, /ClipProjectItem\.cast\(item\)/);
  });

  it("서버가 원본 파일명을 함께 준다 — 없으면 사람이 매번 골라야 한다", () => {
    assert.match(index, /mediaFilename: master \? String\(master\.filename \?\? ""\) : "",/);
  });

  it("구간 밖으로 못 늘리게 잠근다(hasHardBoundaries) — AI 가 고른 구간이 바깥 경계다", () => {
    assert.match(panel, /createSubClipAction\(label, start, end, true\)/);
  });

  it("이름에 추천 id 를 넣는다 — 지연 액션이라 만들어진 항목을 못 돌려받는다", () => {
    assert.match(panel, /\$\{r\.id\}`;/);
  });

  it("빈 탐색에 상한이 있다 — 큰 프로젝트에서 패널이 멈춘 것처럼 보이면 안 된다", () => {
    assert.match(panel, /visited < 2000/);
  });
});

/**
 * 원본이 **편집자 PC 에 아예 없을 수 있다**(사용자 지적 2026-08-31). 그러면 마커도 서브클립도
 * 러프컷도 시작조차 못 한다 — 받아서 프로젝트에 넣는 데까지가 한 기능이다.
 */
describe("패널 — 원본이 없으면 받아서 넣는다", () => {
  it("프로젝트에 있으면 그대로, 없으면 받아서 가져온다", () => {
    assert.match(panel, /async function ensureMaster\(rec, onStage\)/);
    assert.match(panel, /project\.importFiles\(\[file\.nativePath\], true\)/);
  });

  it("가져오기 대화상자를 띄우지 않는다 — 뜨면 자동 흐름이 사람을 기다리며 멈춘다", () => {
    assert.match(panel, /importFiles\(\[file\.nativePath\], true\)/);
  });

  it("저장 폴더는 **한 번만** 묻고 기억한다 — 회차마다 묻는 도구는 아무도 안 쓴다", () => {
    assert.match(panel, /createPersistentToken\(folder\)/);
    assert.match(panel, /getEntryForPersistentToken\(token\)/);
  });

  it("같은 크기의 파일이 이미 있으면 다시 안 받는다 — 수 GB 를 두 번 받는 건 사고다", () => {
    assert.match(panel, /if \(meta && Number\(meta\.size\) === total\)/);
  });

  it("청크로 받아 이어 쓴다 — 통째로 올리면 프리미어까지 같이 죽는다", () => {
    assert.ok(panel.includes('setRequestHeader("Range"'), "Range 요청이 없다");
    assert.ok(panel.includes("nodeFs.writeSync(fd, new Uint8Array(buf), 0, buf.byteLength, off)"),
      "이어 쓰기가 없다 — 통째로 메모리에 올리게 된다");
  });

  it("이어 쓰기를 못 하는 버전에서는 **큰 파일을 거부**한다 — 조용히 메모리를 터뜨리지 않는다", () => {
    assert.match(panel, /total > 512 \* 1024 \* 1024/);
  });

  it("서명 URL 도메인이 매니페스트에 열려 있다", () => {
    assert.ok(manifest.requiredPermissions.network.domains.includes("https://storage.googleapis.com"));
  });
});

/**
 * 러프컷 — 서브클립이 "오려둔 조각" 이라면 러프컷은 **이미 순서대로 붙여 놓은 초벌**이다.
 * 편집자는 다듬기부터 시작한다: 찾고·자르고·늘어놓는 일이 통째로 없어진다.
 */
describe("패널 — 러프컷 시퀀스", () => {
  it("생성과 배치를 한 번에 — 트랙·시각을 우리가 계산하지 않는다", () => {
    assert.match(panel, /createSequenceFromMedia\(seqName, ordered\)/);
  });

  it("추천 순서 그대로 늘어놓는다 — 점수 순 목록이 곧 편집 순서다", () => {
    assert.ok(panel.includes("const ordered = recs.map((r) => found.get(String(r.id))).filter(Boolean);"),
      "추천 순서를 그대로 쓰지 않고 있다");
  });

  it("이름 규칙이 **한 곳**이다 — 두 곳에서 만들면 갈라지는 순간 빈 시퀀스가 나온다", () => {
    assert.match(panel, /function subclipName\(r\) \{/);
    // 서브클립 버튼도 같은 함수를 쓴다(직접 문자열을 조립하지 않는다).
    assert.ok(!/const label = `\[STEP-D\] \$\{\(r\.title/.test(panel), "이름을 또 조립하고 있다");
  });

  it("만든 뒤 시퀀스를 연다 — 안 열면 '눌렀는데 아무 일도 안 일어났다' 가 된다", () => {
    assert.match(panel, /setActiveSequence\(seq\)/);
  });

  it("못 찾은 조각 수를 사람에게 말한다 — 조용히 빠지면 안 된다", () => {
    assert.match(panel, /missing: recs\.length - ordered\.length/);
    assert.match(panel, /개는 조각을 못 찾아 빠졌습니다/);
  });
});

/**
 * 화면 겹침 (2026-08-31 실측) — 로그인 뒤에도 로그인 화면이 안 사라지고 본 화면과 겹쳐 보였다.
 * 원인은 CSS 특정도다: `#loginView { display:flex }` 같은 **ID 선택자(100)** 가
 * `.hidden { display:none }` **클래스(10)** 를 이긴다. 숨김은 어떤 배치 규칙보다 세야 한다.
 */
describe("패널 화면 전환 — 숨김이 배치를 이겨야 한다", () => {
  const html = read("packages/premiere/index.html");

  it("`.hidden` 이 ID 선택자를 이긴다", () => {
    assert.match(html, /\.hidden \{ display: none !important; \}/,
      "ID 선택자로 display 를 잡는 컨테이너가 있어 !important 없이는 안 숨겨진다");
  });

  it("숨기는 컨테이너들이 실제로 ID 로 display 를 잡고 있다 — 그래서 위 규칙이 필요하다", () => {
    // 이 전제가 사라지면(ID 로 display 를 안 잡으면) 위 !important 도 걷어낼 수 있다.
    assert.match(html, /#loginView, #uploadView \{ display: flex;/);
    assert.match(html, /#uploadPane, #recsPane \{ display: flex;/);
  });

  it("전환은 className 을 통째로 갈아끼운다 — 다른 클래스가 섞이면 이 방식이 깨진다", () => {
    assert.match(panel, /views\.login\(\)\.className = which === "login" \? "" : "hidden";/);
  });
});

/**
 * UXP 함정 — **프리미어에서 받은 객체는 `await` 를 건너면 무효가 된다**
 * ("The script object is no longer valid" · 2026-08-31 실측). 다운로드처럼 긴 대기를 사이에
 * 두면 확실히 터진다. 그래서 찾은 객체는 **그 자리에서** 쓰고, 밖으로 돌려주지 않는다.
 */
describe("패널 — 호스트 객체를 await 너머로 들고 다니지 않는다", () => {
  it("원본 클립은 찾은 자리에서 쓴다(콜백) — 돌려주지 않는다", () => {
    assert.match(panel, /async function findMasterItem\(filename, use\)/);
    assert.match(panel, /return await use\(\{ api, project, clip, name: item\.name \}\);/);
  });

  it("ensureMaster 는 **파일명만** 돌려준다 — 다운로드 대기를 건너는 자리라 객체를 못 들고 나온다", () => {
    assert.match(panel, /const present = await findMasterItem\(filename, \(\) => true\)/);
    assert.match(panel, /return filename \|\| file\.name;/);
  });

  it("모은 서브클립도 그 자리에서 시퀀스로 만든다", () => {
    assert.match(panel, /async function findItemsByRecIds\(recIds, use\)/);
    assert.match(panel, /return await use\(want, project, api\);/);
  });
});

/**
 * 편집자 동선 (사용자 2026-08-31): *"나는솔로 3화 편집본 만들어야 해"* →
 * **프로그램 → 회차 → 추천을 보고 골라서** 편집.
 *
 * 예전엔 회차가 섞여 나오고 버튼이 **목록 전체**에 작용했다 — 3화를 만들려는데 1·2화 구간이
 * 같이 잘려 들어간다. 편집자가 쓸 수 없는 도구였다.
 */
describe("패널 — 회차 고르고, 쓸 것만 고른다", () => {
  const html = read("packages/premiere/index.html");

  it("회차 드롭다운이 있다", () => {
    assert.match(html, /<select id="episode"><\/select>/);
    assert.match(panel, /function renderEpisodes\(\)/);
  });

  it("작업 대상은 **보이는 것 중 체크된 것**이다 — 목록 전체가 아니다", () => {
    assert.match(panel, /function visibleRecs\(\)/);
    assert.match(panel, /function chosenRecs\(\)/);
    assert.match(panel, /const picks = chosenRecs\(\);/);
    // 러프컷·마커·서브클립이 전부 picks 를 받는다.
    assert.match(panel, /buildRoughCut\(picks,/);
    assert.match(panel, /addMarkersForRecs\(picks\)/);
    assert.match(panel, /makeSubclipsForRecs\(picks,/);
  });

  it("회차 필터는 episodeId 로 거른다 — 회차 번호는 프로그램마다 겹친다", () => {
    assert.match(panel, /String\(r\.episodeId \|\| ""\) === ep/);
  });

  it("버튼이 선택 건수를 말한다 — 몇 건에 작용하는지 모르고 누르면 안 된다", () => {
    assert.match(panel, /el\.textContent = n > 0 \? `\$\{label\} \(\$\{n\}건\)` : label;/);
  });

  it("기본은 **쇼츠 구간 전부** 선택 — 다 쓰고 빼는 편이 손이 덜 간다", () => {
    // 2026-09-01: 회차 통짜(clip · 수백 초)까지 체크돼 있으면 "전체 선택" 한 번에 14분짜리를
    // 마커·러프컷 대상으로 끌고 간다. 그래서 기본 선택에서만 뺀다(목록에는 남는다).
    assert.ok(panel.includes("selectedIds = new Set(recRows.filter(isShortRec).map((r) => String(r.id)));"));
  });
});

/**
 * 주 동선 확정 (사용자 2026-08-31): *"원본 받아서 추천 구간에 다 마커 넣어주는 게 제일 좋다.
 * 추천 구간 앞뒤로 조금 자르거나 조절되면 좋으니까."*
 *
 * 왜 마커인가: 서브클립은 경계가 잠겨(hasHardBoundaries) 앞뒤를 못 늘린다. 편집자는 추천
 * 구간을 조금씩 조절하며 쓰므로 **표시만 하는 마커**가 맞다.
 */
describe("패널 — 주 동선: 원본 받고 마커", () => {
  const html = read("packages/premiere/index.html");

  it("주 버튼은 **쇼츠 만들기** 하나 — 마커는 보조로 내렸다", () => {
    // 사용자 판단 2026-09-01: "마커 뜨긴 하는데 이 기능이 유의미한가 의문". 마커는 표시만
    // 남기고 일이 그대로 남는다. 주 버튼은 다듬기만 남기는 쪽이어야 한다.
    assert.match(html, /<button id="makeShortsBtn" disabled>고른 구간 쇼츠로 만들기<\/button>/);
    assert.match(html, /<button id="prepMarkBtn" class="secondary"/);
    assert.match(html, /<button id="roughcutBtn" class="secondary"/);
    assert.match(html, /<button id="subclipBtn" class="secondary"/);
  });

  it("쇼츠 만들기와 제목 클릭이 **같은 본체**를 쓴다 — 두 벌이면 갈라진다", () => {
    assert.ok(panel.includes("async function addOverlaysForPreview(r, onStage)"));
    const make = panel.slice(panel.indexOf("async function buildShortForRec("));
    assert.ok(make.indexOf("addOverlaysForPreview(r, onStage)") > 0);
    const jump = panel.slice(panel.indexOf("async function jumpToRec("));
    assert.ok(jump.indexOf("addOverlaysForPreview(r, onStage)") > 0);
  });

  it("원본 확보 → 타임라인 확보 → 마커 순서다", () => {
    const fn = panel.slice(panel.indexOf("async function doPrepareAndMark()"));
    const a = fn.indexOf("ensureMaster(withMedia, onStage)");
    const b = fn.indexOf("ensureSequenceForMaster(filename, onStage, withMedia)");
    const c = fn.indexOf("addMarkersForRecs(picks)");
    assert.ok(a > 0 && b > a && c > b, "순서가 어긋나면 꽂을 타임라인이 없다");
  });

  it("**그 원본의** 타임라인을 연다 — 열려 있는 남의 시퀀스를 쓰지 않는다", () => {
    // 실측 2026-09-01: 예전엔 활성 시퀀스가 있으면 그걸 썼다. 그래서 마커가 엉뚱한
    // 타임라인(다른 녹음 시퀀스)에 꽂히고, 패널은 "됐다" 는데 화면엔 아무 일도 안 일어났다.
    assert.ok(panel.includes("function masterSequenceName(filename)"));
    assert.ok(panel.includes("const existing = await findSequenceByName(project, wanted);"));
    assert.ok(panel.includes("createSequenceFromMedia(wanted, [clip])"),
      "찾을 때와 만들 때가 같은 이름이어야 한다");
  });

  it("영상 트랙이 없으면 **말해 준다** — 성공했다면서 아무 일도 안 일어나는 게 제일 나쁘다", () => {
    assert.ok(panel.includes("async function warnIfNoVideoTrack(sequence, onStage)"));
    assert.ok(panel.includes("영상 트랙이 없습니다"));
    assert.ok(panel.includes("await sequence.getVideoTrackCount()"));
  });

  it("없으면 원본으로 타임라인을 만든다 — 마커는 시퀀스에 꽂히기 때문이다", () => {
    assert.ok(panel.includes("await proj.createSequenceFromMedia(wanted, [clip])"));
  });
});

/**
 * 글꼴 (사용자 2026-08-31: "안 깔려 있으면 인식해서 깔게끔도 해줘야 해").
 *
 * 서버 렌더는 컨테이너에 폰트를 넣어 두지만(Dockerfile) **편집자 PC 는 아무도 안 챙긴다.**
 * 제목 자체는 서버가 그린 PNG 라 안전하지만(2026-08-31 전환), 편집자가 프리미어에서 직접
 * 넣는 자막은 로컬 글꼴로 그려진다 — 없으면 한 영상 안에서 제목과 자막의 글꼴이 갈린다.
 */
describe("패널 — 글꼴 확인", () => {
  it("설치 여부를 사용자·시스템 폰트 폴더에서 본다", () => {
    assert.match(panel, /function fontsInstalled\(\)/);
    assert.ok(panel.includes("/Microsoft/Windows/Fonts"),
      "경로를 슬래시로 쓰지 않으면 역슬래시 이스케이프에서 조용히 깨진다");
  });

  it("판정 불가면 **아무 말도 하지 않는다** — 근거 없는 경고는 소음이다", () => {
    assert.ok(panel.includes("if (ok === false) {"), "false 일 때만 경고해야 한다");
    assert.ok(panel.includes('typeof nodeFs.openSync !== "function") return null;'),
      "확인 불가를 null 로 구분하지 않는다 — 그러면 못 읽은 걸 '없다' 로 오인한다");
  });

  it("설치 스크립트는 관리자 권한 없이 도는 사용자 폰트 설치다", () => {
    const ps = read("packages/premiere/launcher/install-fonts.ps1");
    assert.ok(ps.includes("LOCALAPPDATA"), "사용자 폰트 폴더를 안 쓴다");
    assert.ok(ps.includes(String.raw`HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts`),
      "HKCU 등록이 없다 — 복사만으로는 앱이 글꼴을 못 찾는다");
    assert.ok(ps.includes("관리자 권한이 필요 없다"));
  });

  it("이미 있으면 다시 넣지 않는다 — 중복 등록이면 어느 쪽이 쓰이는지 알 수 없다", () => {
    const ps = read("packages/premiere/launcher/install-fonts.ps1");
    assert.match(ps, /if \(Test-Path \$target\) \{\s*\n\s*Write-Host "이미 있음/);
  });
});

/**
 * 추천 목록 (실측 2026-09-01): 패널에 회차당 **1건**만 떴다. 실제로는 1회 short 3건 · 2회 4건이
 * 있었는데 **전부 채택됨(adopted)** 이라 pending 필터에 걸려 사라졌고, 남은 건 회차 통짜
 * clip 후보(665·843초) 하나뿐이었다.
 *
 * 편집자는 **이미 채택한 구간을 프리미어에서 다시 다듬는** 일이 오히려 흔하다. 숨기면 패널이
 * 비어 보이고, 사람은 "추천이 없네" 라고 오해한다.
 */
describe("패널 — 세로가 부족해도 손이 닿는다", () => {
  const html = read("packages/premiere/index.html");

  // 사용자 2026-09-01: "스크롤 필요해 보여 · 너무 보기가 불편함". 내용이 패널 높이를 넘치면
  // 아래가 잘려 **버튼을 못 누른다**. UXP 패널은 도킹 시 특히 좁다.
  it("패널 전체가 스크롤된다 — 넘치는 내용이 잘려 사라지지 않게", () => {
    assert.match(html, /html, body \{ height: 100%; \}/);
    assert.match(html, /overflow-y: auto;/);
  });

  it("추천 목록은 **자기 안에서** 스크롤한다 — 20건이 와도 버튼이 밀리지 않게", () => {
    const block = html.slice(html.indexOf(".recs {"), html.indexOf(".recs {") + 320);
    assert.match(block, /max-height: 45vh/, "목록에 상한이 없으면 아래 버튼이 화면 밖으로 간다");
    assert.match(block, /overflow-y: auto/);
  });
});

describe("패널 — 추천 목록은 채택된 것도 보여 준다", () => {
  it("status=all 로 받는다 — pending 만 받으면 작업할 게 사라진다", () => {
    assert.ok(panel.includes("&status=all&limit=100"));
  });

  it("쇼츠 구간이 먼저, 회차 통짜는 뒤로 — 지우지는 않는다", () => {
    assert.ok(panel.includes("function isShortRec(r)"));
    assert.ok(panel.includes("const sa = isShortRec(a) ? 0 : 1, sb = isShortRec(b) ? 0 : 1;"));
  });

  it("기본 선택은 쇼츠 구간만 — 전체 선택 한 번에 14분짜리를 끌고 가면 안 된다", () => {
    assert.ok(panel.includes("selectedIds = new Set(recRows.filter(isShortRec).map((r) => String(r.id)));"));
  });

  it("채택 여부를 **표시**한다 — 숨기는 대신 보여 주고 판단은 사람이", () => {
    assert.ok(panel.includes('st === "adopted" ? " · ✔ 채택됨"'));
  });

  it("서버가 kind 를 실어 보낸다 — 패널이 길이로 추측하지 않게", () => {
    assert.ok(index.includes('kind: String(r.kind ?? ""),'));
  });
});

/**
 * 폴더 권한 창 (사용자 2026-09-01: **"버튼 누르면 파일 저장창 여러 번 뜨는데 이거 알아서
 * 저장 못하나"**). 자산까지 `getFolder()` 로 물어서 한 작업에 창이 여섯 번까지 떴다.
 */
describe("패널 — 폴더는 한 번만 묻는다", () => {
  it("우리 자산은 **묻지 않는다** — 권한 없는 플러그인 데이터 폴더에 둔다", () => {
    assert.ok(panel.includes("async function assetFolder()"));
    assert.ok(panel.includes("localFs.getDataFolder()"));
    // 제목·자막·오버레이는 전부 assetFolder 를 쓴다.
    for (const fn of ["addTitlePngs", "addTitleMogrts", "addCaptionPngs", "addCaptionMogrts", "addDecorationsForRecs"]) {
      const body = panel.slice(panel.indexOf(`async function ${fn}(`), panel.indexOf(`async function ${fn}(`) + 400);
      assert.ok(body.includes("await assetFolder()"), `${fn} 이 아직 폴더를 묻는다`);
    }
  });

  it("원본 폴더는 세션 캐시 — 토큰이 안 풀려도 창이 반복되지 않는다", () => {
    assert.ok(panel.includes("let cachedMediaFolder = null;"));
    assert.ok(panel.includes("if (cachedMediaFolder) return cachedMediaFolder;"));
    // 원본만 묻는다(용량이 크고 편집자가 어디 쌓이는지 알아야 한다).
    const dl = panel.slice(panel.indexOf("async function downloadMaster("));
    assert.ok(dl.slice(0, 200).includes("await mediaFolder()"));
  });
});

/**
 * 편집본 ↔ 추천 잇기 (2026-09-01). 프리미어에서 다듬어 올린 결과가 **어느 추천에서 나왔는지**
 * 기록되지 않으면, "어떤 추천이 실제로 편집까지 갔나" 를 나중에 셀 방법이 없다.
 *
 * 프리미어에는 임의 메타를 붙일 자리가 없다(프로젝트 항목에 커스텀 필드가 없다).
 * 그래서 **이름이 유일한 끈**이다 — 우리가 만든 시퀀스·조각은 끝에 추천 id 를 단다.
 */
describe("패널 — 편집본을 추천에 잇는다", () => {
  it("시퀀스 이름에서 추천 id 를 되읽는다 — 만들 때와 같은 규칙", () => {
    assert.ok(panel.includes("function recIdFromName(name)"));
    assert.ok(panel.includes("`[STEP-D] ${String(r.title || \"추천\").slice(0, 40)} · ${r.id}`"),
      "이름 규칙이 바뀌면 되읽기도 같이 바뀌어야 한다");
  });

  it("맥락은 **렌더 전에** 읽는다 — 렌더가 끝나면 시퀀스가 바뀌어 있을 수 있다", () => {
    const fn = panel.slice(panel.indexOf("async function doExportAndUpload()"));
    const ctx = fn.indexOf("await exportContext()");
    const exp = fn.indexOf("await exportActiveSequence(");
    assert.ok(ctx > 0 && exp > ctx, "렌더 뒤에 읽으면 엉뚱한 시퀀스를 가리킬 수 있다");
  });

  it("끈이 끊겨도 업로드는 된다 — 링크 하나 때문에 몇 GB 를 버리지 않는다", () => {
    assert.ok(panel.includes("return null;      // 시퀀스를 못 읽어도 업로드는 막지 않는다"));
    assert.ok(index.includes("// 없는 추천 id 는 **조용히 무시**한다"));
  });

  it("서버가 출처를 클립에 남긴다 — 이게 유일한 기록이다", () => {
    assert.ok(index.includes("sourceRecommendationId ? { sourceRecommendationId: opts.sourceRecommendationId } : {}"));
  });

  it("회차 번호를 추천에서 물려받는다 — 편집자가 다시 고르지 않게", () => {
    assert.ok(index.includes("if (episodeNumber === undefined && rec.episodeId)"));
  });
});

/**
 * 호스트 객체 무효화 — 실측 2026-08-31: 패널이 *"The script object is no longer valid."* 로 멈췄다.
 *
 * 원인은 **목록을 훑는 도중의 await** 다. `await clip.getMediaFilePath()` 하나가 같은 목록의
 * 남은 항목을 무효로 만든다. 프로젝트에 빈이 늘자(모션 그래픽 템플릿 빈이 생기면서) 터졌다.
 */
describe("패널 — 객체 무효화를 견딘다", () => {
  it("이름으로 먼저 찾는다 — 이름은 await 없이 읽힌다", () => {
    assert.ok(panel.includes("async function findMasterItemOnce(filename, use)"));
    const fn = panel.slice(panel.indexOf("async function findMasterItemOnce("));
    const byName = fn.indexOf("String(item.name || \"\").toLowerCase()");
    const byPath = fn.indexOf("await clip.getMediaFilePath()");
    assert.ok(byName > 0 && byPath > byName, "경로부터 물으면 목록이 무효가 된다");
  });

  it("모든 트랜잭션이 **프로젝트를 잠근 채** 돈다 — 이게 공식 처방이다", () => {
    // 공식 선언: lockedAccess = "project state will not change during the execution of
    // callback function. Can call executeTransaction while having locked access."
    assert.ok(panel.includes("function lockedTransaction(project, build, label)"));
    assert.ok(panel.includes("project.lockedAccess(() => { out = fn(); });"));
    // 직접 호출은 **전부 runLocked 블록 안**이어야 한다(들여쓰기가 깊다).
    // 밖에 하나라도 남으면 거기서 또 "Requires locked access" 가 난다.
    // 모든 executeTransaction 은 **같은 줄에 runLocked 가 있거나**(헬퍼 형태) 잠금 블록
    // 안(들여쓰기 6칸 이상)이어야 한다. 하나라도 밖에 있으면 거기서 또 난다.
    const lines = panel.split(String.fromCharCode(10)).filter((l) => /executeTransaction[(]/.test(l));
    const outside = lines.filter((l) => !/runLocked[(]/.test(l) && !/^\s{6,}/.test(l));
    assert.equal(outside.length, 0, "잠금 밖 executeTransaction 이 남아 있다");
    assert.ok(lines.length >= 4, "잠금 안 트랜잭션이 사라졌다 — 배치 경로가 빠졌나");
  });

  it("무효화면 **한 번만** 다시 돈다 — 무한 재시도는 멈춘 것처럼 보인다", () => {
    assert.ok(panel.includes("async function retryStale(label, fn)"));
    assert.ok(panel.includes("function isStaleObjectError(err)"));
    const fn = panel.slice(panel.indexOf("async function retryStale("), panel.indexOf("/** 실패 메시지에"));
    assert.equal((fn.match(/await fn\(\)/g) ?? []).length, 2, "재시도는 딱 한 번이어야 한다");
  });

  it("mogrt 는 **줄마다 editor 를 다시 얻는다** — 앞 삽입이 뒤를 무효로 만든다", () => {
    const t = panel.slice(panel.indexOf("async function addTitleMogrts("), panel.indexOf("async function addTitlePngs("));
    assert.ok(t.includes("for (const { rec, file } of files) {"));
    assert.ok(t.indexOf("await activeSequence()") > t.indexOf("for (const { rec, file } of files) {"),
      "editor 를 루프 밖에서 들고 있다");
  });

  it("실패 메시지에 **단계 이름**이 붙는다 — 원문만으론 어디서 났는지 모른다", () => {
    assert.ok(panel.includes("async function stage(label, fn)"));
    assert.ok(panel.includes('await stage("원본 확인"'));
    assert.ok(panel.includes('await stage("타임라인 준비"'));
    assert.ok(panel.includes('await stage("마커 꽂기"'));
  });
});

/**
 * 자막 재현 (사용자 2026-08-31: **"자막도 타임스탬프 맞춰서 프리미어에 재현."**).
 *
 * 프리미어 **캡션 트랙에는 API 로 얹을 수 없다**(공식 선언에 배치 API 가 없다 — Transcript 는
 * 마스터 클립에 붙이는 것이고 캡션 트랙 배치는 UI 조작뿐이다). 그래서 줄마다 정지 PNG 를
 * 줄 길이만큼 V4 에 놓는다 — 글꼴·색·위치·시각이 결과물과 같다.
 */
describe("패널 — 자막을 타임스탬프대로", () => {
  it("렌더와 **같은 줄 나누기**를 쓴다 — 원문을 주면 줄 수가 달라진다", () => {
    assert.ok(index.includes("async function recCaptionLines(rec: any, esn: any)"));
    assert.ok(index.includes("windowCaptions(resolved.segments"));
    assert.ok(index.includes("chunkCaption(c, captionMaxCharsOf(esn))"));
  });

  it("PNG 로 물러난 **이유를 화면에** 말한다 — 콘솔에만 남기면 아무도 못 본다", () => {
    // 실측 2026-09-01: 베이스 템플릿이 한 번도 안 올라가 매번 409 였는데, 화면엔 아무 말이
    // 없어서 "제목이 왜 이미지지?" 로만 보였다. 조용한 폴백이 제일 나쁘다.
    assert.ok(panel.includes("let lastTitleFallbackReason"));
    assert.ok(panel.includes("제목을 이미지로 대체합니다 — ${lastTitleFallbackReason}"));
    assert.ok(panel.includes("제목 템플릿 등록 실패 — ${err.message}"));
  });

  it("그래픽은 **구간 시작부터 끝까지** 간다 — 기본 길이(5초)로 들어가면 앞부분만 덮는다", () => {
    // 사용자 2026-09-01: "그래픽은 영상 시작부터 끝 해서 적용".
    assert.ok(panel.includes("c.addAction(item.createSetInOutPointsAction("),
      "이미지 오버레이 길이를 안 정하면 정지 이미지 기본 길이로 들어간다");
    assert.ok(panel.includes("c.addAction(item.createSetEndAction(api.TickTime.createWithSeconds(endSec)));"),
      "제목 mogrt 를 구간 끝까지 안 늘린다");
  });

  it("미리보기 rec 은 **끝 시각도** 시퀀스 시간으로 옮긴다 — 안 옮기면 길이가 원본 절대시각이 된다", () => {
    assert.ok(panel.includes("const local = { ...r, startTime: 0, endTime: dur };"));
  });

  it("mogrt 삽입은 **잠금 안에서 시작하고 잠금 밖에서 기다린다**", () => {
    // 잠금 밖에서 부르면 "Requires locked access", 잠금 콜백은 동기라 안에서 await 불가.
    // 둘을 같이 만족시키는 유일한 방법이고, 실패하면 PNG 로 물러나 **파일이 흩뿌려진다**.
    assert.ok(panel.includes("const started = runLocked(project, () => {"));
    assert.ok(panel.includes('const inserted = started && typeof started.then === "function" ? await started : started;'));
    assert.ok(!panel.includes("비동기 — 잠금 안에서 확인 불가, PNG 로 간다"),
      "비동기라고 곧장 PNG 로 물러나던 옛 경로가 남아 있다");
  });

  it("자막도 **편집 가능한 mogrt 가 먼저**다 — PNG 는 폴백이다", () => {
    assert.ok(index.includes('app.get("/api/recommendations/:id/caption.mogrt"'));
    const fn = panel.slice(panel.indexOf("async function addCaptionsForRecs("));
    const a = fn.indexOf("addCaptionMogrts(");
    const b = fn.indexOf("addCaptionPngs(");
    assert.ok(a > 0 && b > a, "PNG 가 먼저면 편집 불가가 기본이 된다");
  });

  it("박스형 자막 스타일은 mogrt 로 안 만든다 — 도형을 못 옮긴다", () => {
    assert.ok(index.includes('const CAPTION_BOX_STYLES = new Set(["news", "pink_bubble", "highlight_bar", "typewriter"]);'));
    assert.ok(index.includes('return c.json({ error: "boxed_caption_style" }, 409);'));
    assert.ok(panel.includes("if (res.status === 409) return 0;"), "409 면 통째로 PNG 로 가야 한다");
  });

  it("자막 mogrt 는 썸네일을 뗀다 — 수십 장을 내리는 자리다", () => {
    assert.ok(index.includes("{ stripThumbs: true }"));
  });

  it("넣은 뒤 **끝 시각을 줄 길이에 맞춘다** — 안 하면 자막끼리 겹친다", () => {
    assert.ok(panel.includes("item.createSetEndAction(end)"));
  });

  it("mogrt·PNG 두 경로가 **같은 줄**을 쓴다 — 줄 목록 수집은 한 군데다", () => {
    assert.ok(panel.includes("async function captionJobs(recs, aspect)"));
    const mog = panel.slice(panel.indexOf("async function addCaptionMogrts("));
    const png = panel.slice(panel.indexOf("async function addCaptionPngs("));
    assert.ok(mog.includes("await captionJobs(recs, aspect)"));
    assert.ok(png.includes("await captionJobs(recs, aspect)"));
  });

  it("한 줄을 0초에 놓고 한 프레임 뜬다 — 그래야 그 줄이 그림에 나온다", () => {
    assert.ok(index.includes("[{ start: 0, end: dur, text: line.text }], { include: \"captions\" }"));
  });

  it("길이를 먼저 정하고 얹는다 — 안 하면 정지 이미지 기본 길이(5초)로 서로 덮어쓴다", () => {
    assert.ok(panel.includes("c.addAction(item.createSetInOutPointsAction("));
    assert.ok(panel.includes("c.addAction(editor.createOverwriteItemAction(item, at, CAPTION_TRACK, 0));"));
  });

  it("자막은 V4 — 제목·로고 위 트랙이다", () => {
    assert.ok(panel.includes("const CAPTION_TRACK = 3;"));
    assert.ok(panel.includes("createOverwriteItemAction(item, at, CAPTION_TRACK, 0)"));
  });

  it("상한이 있다 — 회차 전체(수백 줄)를 실수로 얹으면 프리미어가 멎는다", () => {
    assert.ok(panel.includes("const CAPTION_MAX_LINES = 200;"));
    assert.ok(panel.includes("jobs.length < CAPTION_MAX_LINES"));
  });

  it("미리보기에서만 얹는다 — 원본 전체 타임라인에 회차 자막을 깔지 않는다", () => {
    // 자막은 미리보기 오버레이 본체에서만 얹는다.
    const fn = panel.slice(panel.indexOf("async function addOverlaysForPreview("));
    assert.ok(fn.indexOf("addCaptionsForRecs(") > 0, "미리보기 경로에 자막이 없다");
    const bulk = panel.slice(panel.indexOf("async function doPrepareAndMark("), panel.indexOf("async function loadRecs("));
    assert.ok(!bulk.includes("addCaptionsForRecs("), "마커 경로에 자막을 넣으면 수백 줄이 깔린다");
  });
});

/**
 * 로고·시간박스 재현 (사용자 2026-08-31: **"로고, 시간박스까지 다 재현."**).
 *
 * 시간박스는 ASS BorderStyle=3 박스, 로고는 ffmpeg 원형 크롭이다. 캔버스로 흉내 내면 두 경로가
 * 미묘하게 어긋나고 그 어긋남은 나중에 아무도 못 찾는다 — **렌더가 쓰는 그 ASS·그 아이콘**을 쓴다.
 */
describe("패널 — 로고·시간박스까지 재현", () => {
  it("서버가 렌더와 같은 재료로 합성한다 — 캔버스로 다시 그리지 않는다", () => {
    assert.ok(index.includes('app.get("/api/recommendations/:id/decorations.png"'));
    assert.ok(index.includes("await renderStaticOverlayPng({"));
    assert.ok(index.includes("await circleCrop(iconRaw, iconPng, iconH);"), "로고 원형 크롭이 렌더와 다르다");
  });

  it("합성 순서가 렌더와 같다 — 텍스트 PNG → ASS → 배지", () => {
    const ff = read("apps/server/src/media/ffmpeg.ts");
    const fn = ff.slice(ff.indexOf("export function renderStaticOverlayPng"));
    const a = fn.indexOf("opts.overlayPngPath");
    const b = fn.indexOf("opts.assPath");
    const c = fn.indexOf("opts.badge");
    assert.ok(a > 0 && b > a && c > b, "순서가 어긋나면 시간박스가 로고 위로 온다");
  });

  it("제목은 빠진다 — 그건 고칠 수 있어야 해서 .mogrt 로 나간다", () => {
    assert.ok(index.includes('.filter((it) => it.group === "channel")'));
    assert.ok(index.includes('staticToPng: true, include: "decorations"'),
      "자막·제목을 안 빼면 두 번 그려진다");
  });

  it("트랙은 제목보다 위다 — 시간박스가 제목 뒤로 가면 안 된다", () => {
    assert.ok(panel.includes("const TITLE_TRACK = 1;"));
    assert.ok(panel.includes("const DECORATION_TRACK = 2;"));
    assert.ok(panel.includes("DECORATION_TRACK, \"오버레이\""), "오버레이가 제목 트랙에 얹히면 가려진다");
  });

  it("오버레이 실패가 제목을 되돌리지 않는다 — 앞의 성과를 지킨다", () => {
    assert.ok(panel.includes('console.log("[STEP-D] 로고·시간박스 실패", err);'));
  });

  it("/tmp 를 반드시 지운다 — Cloud Run 의 /tmp 는 RAM 이라 쌓이면 OOM 이다", () => {
    assert.ok(index.includes("const cleanup = () => {"));
    // 성공·404·예외 세 갈래 모두에서 지워야 한다.
    const fn = index.slice(index.indexOf('app.get("/api/recommendations/:id/decorations.png"'));
    const body = fn.slice(0, fn.indexOf("\n});"));
    assert.ok((body.match(/cleanup\(\);/g) ?? []).length >= 3, "빠져나가는 길마다 지우지 않는다");
  });
});

/**
 * 배치 재현 (사용자 2026-08-31: **"영상 꽉 차게 아니고 레이아웃도 받아서 프리미어 재현."**).
 *
 * 기본 템플릿 `9:16-crop-main` 은 꽉 채우지 않는다 — 위 440px 은 제목이 앉는 검은 띠고,
 * 영상은 그 아래 1080×1480 사각형에만 들어간다. 패널이 꽉 채우면 편집자가 본 화면과
 * 실제 발행물이 다르다. **숫자를 패널에 복제하지 않고** 서버 프리셋을 받아 쓴다.
 */
describe("패널 — 영상 배치는 서버 프리셋을 따른다", () => {
  it("배치를 서버에서 받는다 — 복제하면 프리셋을 고쳐도 프리미어만 옛 배치로 남는다", () => {
    assert.ok(panel.includes("async function fetchLayout(rec)"));
    assert.ok(panel.includes("/layout`, { method: \"GET\" })"));
    assert.ok(index.includes('app.get("/api/recommendations/:id/layout"'));
  });

  it("서버는 ASPECT_PRESETS 를 그대로 내려 준다 — 여기서 계산을 새로 하지 않는다", () => {
    assert.ok(index.includes("const preset = getAspectPreset(aspect) ?? getAspectPreset(SHORTS_DEFAULT_ASPECT)!;"));
    assert.ok(index.includes("video: preset.rect"));
  });

  it("rect 면 그 사각형에 cover, contain 이면 담기 — 배율·위치를 그렇게 계산한다", () => {
    assert.ok(panel.includes('video.fill === "contain"'));
    assert.ok(panel.includes("Math.min(box.w / src.w, box.h / src.h)"));
    assert.ok(panel.includes("Math.max(box.w / src.w, box.h / src.h)"));
    assert.ok(panel.includes("const posX = (box.x + box.w / 2) / canvas.w;"));
  });

  it("Motion 의 위치·배율을 **한 트랜잭션**으로 건다 — 되돌리기가 두 번이 되면 안 된다", () => {
    assert.ok(panel.includes("const MOTION_POSITION_PARAM = 0;"));
    assert.ok(panel.includes("const MOTION_SCALE_PARAM = 1;"));
    assert.ok(panel.includes('}, "STEP-D 영상 배치");'), "위치·배율이 한 트랜잭션이 아니다");
    assert.ok(panel.includes("compound.addAction(p.createSetValueAction(p.createKeyframe(want.scale), true));"),
      "액션을 잠금 밖에서 만들면 Requires locked access 가 난다");
  });

  it("배치를 못 받으면 예전 동작(꽉 채우기)으로 물러난다 — 여기서 전체가 멈추면 안 된다", () => {
    assert.ok(panel.includes('const video = (layout && layout.video) || { fill: "cover"'));
  });

  it("제목 비율도 배치를 따른다 — 프레임만 보면 crop-main/sub 를 구분 못 한다", () => {
    assert.ok(panel.includes("let aspect = (layout && layout.aspect) || SHORTS_ASPECT_FALLBACK;"));
    assert.ok(panel.includes('const SHORTS_ASPECT_FALLBACK = "9:16-letterbox";'),
      "패널 폴백이 서버 기본(SHORTS_DEFAULT_ASPECT)과 다르면 배치가 갈린다");
  });
});

/**
 * 추천 클릭 → 그 구간만의 세로 시퀀스 (사용자 2026-08-31: **"누르면 새 시퀀스 만들어서 틀어주자."**).
 *
 * 원본 타임라인에서 그 시각으로 점프하면 **가로 원본**이 보인다. 판단해야 할 건 "이 구간이
 * 쇼츠로 쓸 만한가" 라서, 세로 프레임에 제목까지 얹힌 상태를 봐야 한다.
 */
describe("패널 — 추천을 누르면 미리보기 시퀀스", () => {
  it("그 구간만 잘라 세로 시퀀스로 만든다", () => {
    assert.ok(panel.includes("async function openRecSequence(r)"));
    assert.ok(panel.includes("createSubClipAction("), "구간을 자르지 않는다");
    assert.ok(panel.includes("await makeSequenceVertical(api2, project2, seq,"), "세로로 안 만든다");
  });

  it("두 번째부터는 다시 만들지 않는다 — 같은 이름 시퀀스가 쌓이면 안 된다", () => {
    assert.ok(panel.includes("const existing = await findSequenceByName(project, name);"));
    assert.ok(panel.includes("if (existing) {"));
  });

  it("시퀀스가 없어도 돈다 — 만들어 주려는 기능이 '활성 시퀀스 없음' 으로 막히면 안 된다", () => {
    assert.ok(panel.includes("async function activeProject()"));
    assert.ok(panel.includes("const { api, project } = await activeProject();"));
  });

  it("실패하면 예전처럼 그 시각으로 이동한다 — 아무 일도 안 일어나는 것보다 낫다", () => {
    assert.ok(panel.includes("await seekActiveSequence(Number(r.startTime) || 0);"));
    assert.ok(panel.includes("미리보기를 못 만들어("));
  });

  it("재생은 사람 몫이라고 **말해 준다** — UXP 에 트랜스포트 API 가 없다", () => {
    assert.ok(panel.includes("스페이스바로 재생하세요"),
      "재생이 자동일 거라 기대하게 두면 '눌렀는데 안 틀어진다' 가 된다");
  });
});

/**
 * 세로 시작 (사용자 2026-08-31: **"영상도 세로형으로 해서 시작해야 함."**).
 *
 * 프레임만 1080×1920 으로 바꾸면 **영상은 가운데 작게 남는다**(위아래 검은 띠). 편집자는
 * 그 상태로 프레이밍을 판단할 수 없다 — 클립 배율까지 올려서 꽉 채워야 "쇼츠로 시작" 이다.
 */
describe("패널 — 세로 쇼츠로 시작한다", () => {
  it("마커 경로도 세로다 — 러프컷만 세로면 가로 화면 보며 세로 결과를 상상해야 한다", () => {
    assert.ok(panel.includes("await makeSequenceVertical(api, project, seq, onStage, layout);"),
      "원본으로 만든 타임라인을 세로로 바꾸지 않는다");
  });

  it("편집자 본인 타임라인은 건드리지 않는다 — 우리 것만 맞춘다", () => {
    // 이름으로 **우리가 만든 것**만 찾아 연다(masterSequenceName). 남의 활성 시퀀스를
    // 세로로 바꾸거나 거기에 마커를 꽂지 않는다.
    assert.ok(panel.includes('return `[STEP-D] ${String(filename || "원본")'));
    assert.ok(!panel.includes('String(active.name || "").startsWith("[STEP-D] ")'),
      "활성 시퀀스를 넘겨받아 쓰던 옛 경로가 남아 있다");
  });

  it("영상도 채운다 — 배율은 **바꾸기 전** 프레임 크기(=원본 해상도)에서 계산한다", () => {
    assert.ok(panel.includes("await seq.getFrameSize()"), "원본 해상도를 안 읽는다");
    assert.ok(panel.includes("if (src) await placeClipsByLayout(api, project, seq, src, layout, onStage);"),
      "배치를 적용하지 않는다 — 프레임만 세로면 영상은 가운데 작게 남는다");
  });

  it("모션 컴포넌트는 **matchName** 으로 찾는다 — 표시 이름은 한국어 프리미어에서 '동작' 이다", () => {
    assert.ok(panel.includes('const MOTION_MATCH_NAME = "AE.ADBE Motion";'));
    assert.ok(panel.includes("await comp.getMatchName()"));
  });

  it("확대 실패는 전체를 실패시키지 않는다 — 시퀀스는 이미 세로다", () => {
    assert.ok(panel.includes("'동작(Motion)' 에서 직접 맞춰 주세요"),
      "실패해도 사람이 이어서 할 한 수를 알려줘야 한다");
  });
});

/**
 * 제목 그래픽 — 사용자 요구 2026-08-31: **"사용자가 하는 게 아니라 자동으로 서버에서 내려서."**
 * 그리고 이어진 지적: **"글씨 위치 같은 것도 다 빠질 텐데, 그때그때 생성하면 되지 않을까."**
 *
 * 그래서 `.mogrt`(위치·글꼴이 파일에 박제되는 자산)를 버리고, **웹 경로가 쓰는 그 렌더러**로
 * 그때그때 그린 투명 PNG 를 받아 얹는다. 여기 검사는 그 계약이 조용히 되돌아가지 않게 한다 —
 * 되돌아가면 증상은 "프리미어에서만 옛날 색·옛날 위치" 라 사람이 원인을 못 찾는다.
 */
describe("패널 — 제목은 서버가 찍어 준 .mogrt 를 얹는다", () => {
  it("편집 가능한 경로가 먼저다 — 사용자 요구: \"편집자가 바꿀 수 있길 원한다\"", () => {
    assert.ok(panel.includes("/title.mogrt${q}"), "제목 mogrt 를 받아오지 않는다");
    assert.ok(panel.includes("editor.insertMogrtFromPath(file.nativePath, at, TITLE_TRACK, 0)"));
    const fn = panel.slice(panel.indexOf("async function addTitlesForRecs("));
    const a = fn.indexOf("addTitleMogrts(");
    const b = fn.indexOf("addTitlePngs(");
    assert.ok(a > 0 && b > a, "PNG 가 먼저면 편집 불가 결과가 기본이 된다");
  });

  it("mogrt 가 막히면 PNG 로 물러난다 — 제목이 아예 안 나오는 것보다 낫다", () => {
    assert.ok(panel.includes("console.log(\"[STEP-D] mogrt 제목 실패 — PNG 로 폴백\", err);"));
    assert.ok(panel.includes("/title.png${q}"), "폴백 경로가 사라졌다");
  });

  it("베이스가 없으면(409) 이 PC 의 기본 템플릿을 올리고 **한 번만** 재시도한다", () => {
    assert.ok(panel.includes("if (res.status === 409 && allowSetup)"));
    assert.ok(panel.includes("return fetchTitleMogrt(rec, folder, aspect, onStage, false);"),
      "무한 재시도가 되면 안 된다");
    assert.ok(panel.includes("Basic Lower Third.mogrt"), "두 줄짜리 후보를 먼저 찾지 않는다");
    assert.ok(panel.includes("/Adobe/Common/Motion Graphics Templates"));
  });

  it("서버는 그 베이스를 검증하고 저장한다 — 텍스트 레이어가 없으면 거절", () => {
    assert.ok(index.includes('app.post("/api/premiere/base-template"'));
    assert.ok(index.includes("if (info.textLayers < 1) return c.json"));
    assert.ok(index.includes("PREMIERE_BASE_MAX"), "크기 상한이 없다");
  });

  it("캡슐 id 는 추천마다 다르다 — 같으면 두 번째 제목이 첫 문구로 뜬다", () => {
    assert.ok(index.includes("capsuleId: capsuleIdFor(String(rec.id), aspect)"));
    assert.ok(index.includes("function capsuleIdFor(recId: string, aspect: string)"));
  });

  it("타임라인 비율대로 받는다 — 세로 러프컷에 가로 그림을 얹으면 위치가 어긋난다", () => {
    assert.ok(panel.includes("async function titleTargetInfo(layout)"));
    assert.ok(panel.includes('if (Number(size.width) >= Number(size.height)) aspect = "16:9";'));
    assert.ok(panel.includes("aspect=${encodeURIComponent(aspect)}"));
  });

  it("서버도 그 비율을 받아 그린다 — 기본은 쇼츠(세로)", () => {
    assert.ok(index.includes('const want = c.req.query("aspect");'));
    // 세로 기본은 factory.SHORTS_DEFAULT_ASPECT 한 곳에서 온다(2026-09-01 · letterbox 로 변경).
    assert.ok(index.includes('const aspect = want === "16:9" ? "16:9" : SHORTS_DEFAULT_ASPECT;'));
  });

  it("웹과 **같은 렌더러**를 쓴다 — 복제하면 두 경로가 갈라진다", () => {
    assert.ok(index.includes('await overlayPreviewItems(es, aspect, null, "title")'));
    assert.ok(index.includes("renderTextLayerPng({ width: W, height: H, items })"));
  });

  it("제목 삽입 실패가 마커까지 버리지 않는다 — 앞의 성과를 지키는 자리다", () => {
    assert.ok(panel.includes("titleNote = ` · 제목은 건너뜀(${err.message})`;"));
  });

  it("제목은 V2 트랙에 올린다 — V1 영상 위에 얹혀야 보인다", () => {
    assert.ok(panel.includes('TITLE_TRACK, "제목")') || panel.includes("insertMogrtFromPath(file.nativePath, at, TITLE_TRACK, 0)"),
      "제목이 V2 가 아닌 트랙에 간다");
  });

  it("트랙이 V1 뿐이면 **그게 이유라고** 말한다 — 트랙 추가 API 는 없다", () => {
    assert.ok(panel.includes("타임라인에 비디오 트랙이 V1 뿐입니다"));
  });
});
