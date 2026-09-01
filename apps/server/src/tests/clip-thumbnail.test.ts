import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 클립(롱폼)이 유튜브로 나갈 때 **커스텀 썸네일이 붙는가**.
 *
 * 쇼츠는 유튜브가 프레임을 알아서 쓰지만 일반 영상은 썸네일이 곧 클릭률이다. 자동 프레임으로
 * 나가면 아무리 잘 뽑은 클립도 안 눌린다 — 기능이 있는데 소비처에 미도달하면 없는 것과 같다는
 * 이 리포의 최빈 실패모드를 그대로 밟는 자리라 배선을 소스 스캔으로 고정한다.
 */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(HERE, f), "utf-8");

describe("클립 유튜브 썸네일 배선", () => {
  it("youtube.ts 가 thumbnails.set 을 부를 수 있다", () => {
    const yt = read("youtube.ts");
    assert.match(yt, /export async function setVideoThumbnail/,
      "썸네일 설정 함수가 없다 — 롱폼이 유튜브 자동 프레임으로 나간다");
    assert.match(yt, /upload\/youtube\/v3\/thumbnails\/set/);
    assert.match(yt, /2 \* 1024 \* 1024/, "유튜브 2MB 상한 검사가 없다");
  });

  it("업로드 직후 썸네일을 설정한다", () => {
    const w = read("worker.ts");
    assert.match(w, /setVideoThumbnail\(token, videoId, thumb\)/,
      "업로드는 하는데 썸네일을 안 붙인다");
  });

  it("썸네일 실패가 배포를 실패로 만들지 않는다", () => {
    // 영상은 이미 올라가 있다. 여기서 던지면 성공한 업로드가 '실패' 로 기록되고,
    // 재시도가 같은 영상을 또 올린다(중복 게시).
    const w = read("worker.ts");
    // 썸네일 설정 try/catch 전체를 떼어 본다.
    const block = /const thumb = await resolveClipThumbnail[\s\S]*?catch \(e\)[\s\S]*?\n    \}/.exec(w)?.[0] ?? "";
    assert.notEqual(block, "", "썸네일 설정 블록을 못 찾았다");
    assert.match(block, /catch[\s\S]*console\.warn/, "실패를 삼키지 말고 사유는 남겨야 한다");
    assert.doesNotMatch(block, /markDistributionFailed|throw /,
      "썸네일 실패로 배포를 실패 처리하면, 재시도가 이미 올라간 영상을 또 올린다");
  });

  it("썸네일 선택은 사람 선택 → AI 생성물 → 렌더 프레임 3단이다", () => {
    const w = read("worker.ts");
    const fn = /async function resolveClipThumbnail[\s\S]*?\n}/.exec(w)?.[0] ?? "";
    assert.notEqual(fn, "", "resolveClipThumbnail 을 못 찾았다");
    assert.match(fn, /"chosen"/, "사람이 고른 썸네일을 먼저 쓰지 않는다");
    assert.match(fn, /thumbnailPrefix\(masterId\)/, "썸네일 생성 기능 산출물을 안 본다");
    assert.match(fn, /"frame"/, "폴백(렌더 프레임)이 없다 — 셋 다 없으면 썸네일이 안 붙는다");
  });

  it("2MB 초과 후보는 건너뛰고 다음 것을 쓴다", () => {
    // AI 썸네일은 1280×720 PNG 라 2MB 를 넘길 수 있다. 업로드 직전에 상한을 만나면
    // 그 자리에서 끝나(catch 가 경고만) 썸네일이 **아예 안 붙는다** — 고르는 단계에서 걸러야
    // 렌더 프레임(JPEG·작다)으로 떨어진다.
    const w = read("worker.ts");
    const fn = /async function resolveClipThumbnail[\s\S]*?\n}/.exec(w)?.[0] ?? "";
    assert.match(fn, /MAX_BYTES/, "고르는 단계에 용량 검사가 없다");
    assert.match(fn, /for \(const p of paths\)/,
      "AI 후보를 첫 장만 보고 포기하면 용량 초과 한 장 때문에 나머지를 못 쓴다");
  });

  it("자동배포가 클립을 채택하면 썸네일 생성을 건다", () => {
    const cyc = read("automation-cycle.ts");
    assert.match(cyc, /enqueue\("thumbnail\.generate"/,
      "썸네일 생성 기능이 자동 경로에서 호출되지 않는다");
    assert.match(cyc, /dedupeKey: `thumbnail\.generate:\$\{master\.id\}:\$\{thumbMode\}`/,
      "회차당·방식당 1회로 묶지 않으면 클립마다 생성이 중복으로 돈다(원가)");
    // 방식은 규칙이 정하고, 미지정이면 frame — ai 는 등록 출연자 사진이 있어야 해서
    // 캐스트 미등록(아카이브) 회차에서 전멸한다.
    assert.match(cyc, /isRuleThumbnailMode\(\(rule as any\)\.thumbnailMode\)/,
      "규칙의 썸네일 방식을 순방이 안 읽으면 화면에서 고른 값이 저장만 되고 반영되지 않는다");
    assert.match(cyc, /DEFAULT_RULE_THUMBNAIL_MODE/, "미지정 기본값이 없다");
    // 세로(쇼츠) 규칙에서는 걸지 않는다 — 쇼츠는 커스텀 썸네일을 쓰지 않는다.
    assert.match(cyc, /if \(landscape && master\?\.id/);
  });
});

describe("썸네일 방식 두 갈래 (ai · frame)", () => {
  it("규칙에 방식을 저장·조회한다 (컬럼 유실 금지)", () => {
    // 0032 의 교훈: JSONB 에 숨기면 upsert 가 컬럼을 몰라 조용히 유실된다 → 실컬럼.
    const db = read("db-pg.ts");
    assert.match(db, /thumbnail_mode AS "thumbnailMode"/, "조회 목록에 없다 — 저장해도 안 읽힌다");
    assert.match(db, /thumbnail_mode = \$19/, "갱신문에 없다 — 바꿔도 반영되지 않는다");
  });

  it("잘못된 값은 400 으로 막는다 (조용히 버리지 않는다)", () => {
    const idx = read("index.ts");
    assert.match(idx, /invalid thumbnailMode/,
      "모르는 값을 버리면 '저장은 됐는데 반영이 안 된다'가 된다");
  });

  it("frame 방식은 인물 등록·narrative 를 요구하지 않는다", () => {
    // 이 방식을 만든 이유 자체다 — 캐스트가 안 채워진 아카이브 회차에서도 나와야 한다.
    const w = read("worker.ts");
    assert.match(w, /thumbMode === "ai" && !assets\.castFiles/,
      "frame 인데 출연자 사진을 요구하면 아카이브 회차는 어느 방식으로도 못 만든다");
    assert.match(w, /thumbMode === "ai" && !fs\.existsSync\(path\.join\(analysisDir, "narrative\.json"\)\)/,
      "frame 인데 narrative.json 을 요구하면 같은 이유로 막힌다");
  });
});

describe("쇼츠 첫 3초 훅 — 내레이션(TTS) 배선", () => {
  it("훅 프리롤에 TTS 를 얹고, 실패해도 훅은 나간다", () => {
    const idx = read("index.ts");
    assert.match(idx, /synthesizeHookNarration\(line\)/, "훅에 내레이션을 안 붙인다");
    // 합성 실패는 null → ttsPath 없이 프리롤이 그대로 나가야 한다(목소리 때문에 영상이
    // 안 나가는 게 더 나쁘다).
    assert.match(idx, /\.\.\.\(ttsPath \? \{ ttsPath \} : \{\}\)/,
      "합성 실패가 훅 자체를 막으면 안 된다");
  });

  it("읽는 문구는 어그로 카피이지 훅 대사가 아니다", () => {
    // 훅 구간의 실제 대사는 그 자리에서 이미 들린다 — 같은 말을 두 번 하면 3초가 낭비된다.
    const idx = read("index.ts");
    const block = /const line = String\([\s\S]{0,160}?\)\.trim\(\);/.exec(idx)?.[0] ?? "";
    assert.notEqual(block, "", "내레이션 문구 선택부를 못 찾았다");
    assert.match(block, /hookIntroCaption/);
    assert.doesNotMatch(block, /hookQuote/, "훅 대사를 또 읽으면 같은 말이 겹친다");
  });

  it("덕킹은 사이드체인이다 — 내레이션이 끝나면 원음이 돌아온다", () => {
    // 실측: 고정 감쇠는 내레이션이 끝난 뒤에도 원음을 눌러 뒷부분이 원음보다 9dB 더
    // 조용해졌다(-37.8 vs -28.7). 사이드체인은 -28.7 로 원음과 같게 복귀한다.
    const ff = read("ffmpeg.ts");
    assert.match(ff, /sidechaincompress=threshold=/, "고정 감쇠로 되돌아갔다");
    assert.match(ff, /\[tk\]apad\[tkp\]/,
      "사이드체인을 apad 로 안 늘리면 출력이 내레이션 길이(1.5초)로 잘린다 — 실측");
    assert.match(ff, /amix=inputs=2:duration=first/, "TTS 가 길어도 프리롤 길이에서 잘려야 한다");
  });

  it("내레이션 토글·문구가 렌더 캐시 키에 들어간다", () => {
    // 안 넣으면 문구를 바꿔도 예전 렌더가 그대로 돌아온다(캐시 히트).
    const idx = read("index.ts");
    assert.match(idx, /tts: \(clip\.editorState as any\)\?\.hookTtsOn !== false/);
  });
});
