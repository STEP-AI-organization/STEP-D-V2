/**
 * 프롬프트에 **무엇이 얼마나** 실리는지를 고정한다.
 *
 * 두 가지가 걸려 있다.
 *  · **원가** — 실리는 양이 곧 턴당 비용이다. 문서가 늘 때 아무도 모르게 프롬프트가
 *    두 배가 되는 일을 막는다.
 *  · **재현성** — 같은 질문에 늘 같은 문서가 실려야 답이 이상할 때 원인을 좁힐 수 있다.
 *    문서 선택을 모델에게 맡기지 않고 규칙으로 정한 이유가 그것이다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MAX_DOCS, docText, loadHelpDocs, selectDocs } from "../chatbot/help.ts";
import { CONTEXT_MESSAGES, MAX_THREAD_MESSAGES, threadTitle } from "../chatbot/store.ts";
import { snapshotText } from "../chatbot/snapshot.ts";
import { SYSTEM, turnContext } from "../chatbot/agent.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("도움말 선택", () => {
  it("현재 화면의 문서를 반드시 싣는다", () => {
    const picked = selectDocs("이거 어떻게 하나요", "/automation");
    assert.ok(picked.length > 0, "화면을 줬는데 아무 문서도 안 골랐다");
    assert.equal(picked[0].screen, "/automation", "화면 문서가 첫 번째여야 한다");
  });

  it("화면 없이 질문만으로도 키워드로 고른다", () => {
    const picked = selectDocs("크레딧 충전은 어떻게 하나요?");
    assert.ok(picked.some((d) => d.name.includes("credits")), "크레딧 문서를 못 찾았다");
  });

  it("같은 입력이면 같은 문서가 나온다 — 답이 흔들리면 원인을 못 찾는다", () => {
    const a = selectDocs("배포가 실패했어요", "/distribution").map((d) => d.name);
    const b = selectDocs("배포가 실패했어요", "/distribution").map((d) => d.name);
    assert.deepEqual(a, b);
  });

  it("아무리 넓은 질문이어도 상한을 넘지 않는다", () => {
    const wide = loadHelpDocs().flatMap((d) => d.keywords).join(" ");
    assert.ok(selectDocs(wide).length <= MAX_DOCS, `문서를 ${MAX_DOCS}편 넘게 싣는다`);
  });

  it("관련 없는 질문에는 아무것도 안 싣는다 — 엉뚱한 문서가 답을 오염시키지 않게", () => {
    assert.deepEqual(selectDocs("zzzz qqqq"), []);
  });

  it("긴 문서는 잘리고, 잘렸다고 밝힌다", () => {
    const longest = loadHelpDocs().slice().sort((a, b) => b.body.length - a.body.length)[0];
    const text = docText({ ...longest, body: "가".repeat(9_000) });
    assert.match(text, /여기서 잘렸다/, "잘랐으면서 말하지 않으면 모델이 뒷부분을 지어낸다");
  });
});

describe("대화 컨텍스트 상한", () => {
  it("최근 메시지 수가 스레드 상한보다 훨씬 작다", () => {
    assert.ok(CONTEXT_MESSAGES < MAX_THREAD_MESSAGES / 4,
      "컨텍스트가 스레드 길이에 비례하면 원가도 같이 자란다");
  });

  it("스레드 제목은 첫 질문을 자른 것이고, 빈 질문에도 이름이 있다", () => {
    assert.equal(threadTitle("자동배포 어디서 켜요?"), "자동배포 어디서 켜요?");
    assert.equal(threadTitle(""), "새 대화");
    assert.ok(threadTitle("가".repeat(100)).length <= 41);
  });
});

/**
 * 프롬프트 캐싱 — **고정부가 정말 고정인가.**
 *
 * Gemini 는 요청의 앞부분이 이전 요청과 같으면 그 부분을 캐시에서 읽는다. 두 가지가 걸려 있다.
 *  · **원가** — 앞부분에 변동값이 하나라도 섞이면 캐시가 매번 깨져 그 절감이 통째로 날아간다.
 *  · **격리** — 이 접두사는 **회사를 가로질러 공유된다.** 워크스페이스 값이 들어가면
 *    그건 캐시가 아니라 유출 경로다.
 *
 * 둘 다 "돌아가긴 하는데 조용히 손해/위험" 인 종류라 테스트가 붙잡아야 한다.
 */
describe("프롬프트 캐싱 — 고정 접두사", () => {
  it("고정부가 캐시 최소 크기를 넘는다", () => {
    // 실측 2026-09-03: 2,249자 = 1,225토큰(약 1.8자/토큰). flash-lite 암시적 캐시는
    // **1,024토큰 미만이면 아예 안 걸린다** — 줄이면 캐시가 조용히 꺼진다.
    assert.ok(SYSTEM.length >= 1_900,
      `고정 시스템 프롬프트가 ${SYSTEM.length}자다. 1,024토큰(≈1,900자) 밑이면 캐시가 안 걸린다`);
  });

  it("두 번 읽어도 글자 하나까지 같다", () => {
    assert.equal(SYSTEM, SYSTEM.slice(0));
    assert.doesNotMatch(SYSTEM, /\d{4}-\d{2}-\d{2}/, "날짜가 들어가면 매일 캐시가 깨진다");
  });

  it("워크스페이스 값이 섞이지 않는다 — 회사를 가로질러 공유되는 접두사다", () => {
    // 단어 매칭으로는 못 한다: 예시 답변에 `[크레딧](/credits)` 같은 **화면 경로**가 들어 있고,
    // 그건 고정값이다. 그래서 "무슨 단어가 있나" 대신 **"문자열 리터럴 말고 다른 게 있나"** 를
    // 본다 — 변수든 보간이든 함수 결과든, 값이 끼어들 통로 자체를 막는다.
    const src = fs.readFileSync(path.join(SRC, "chatbot", "agent.ts"), "utf-8");
    const literal = /export const SYSTEM = \[([\s\S]*?)\n\]\.join/.exec(src)?.[1] ?? "";
    assert.notEqual(literal, "", "SYSTEM 리터럴을 못 찾았다 — 형태가 바뀌었으면 이 검사도 고칠 것");

    const offenders = literal
      .split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"))
      // 허용: 큰따옴표 문자열 한 줄 · 화면 목록 호출(고정) 하나.
      .filter((l) => !/^".*",?$/.test(l) && l !== "screenCatalogText(),");
    assert.deepEqual(offenders, [],
      `SYSTEM 이 고정 문자열 말고 다른 것을 담고 있다 — 변동값·고객 데이터가 캐시 접두사에 섞인다:\n  ${offenders.join("\n  ")}`);

    assert.ok(!literal.includes("${"), "SYSTEM 에 템플릿 보간이 있다 — 접두사가 매번 달라진다");
  });

  it("변동값은 전부 맨 뒤 턴에 들어가고, 질문이 마지막이다", () => {
    const text = turnContext("크레딧 잔액: 120개", "### 도움말 본문", "앞선 요약", "질문입니다");
    assert.ok(text.indexOf("크레딧 잔액") < text.indexOf("질문입니다"));
    assert.ok(text.trimEnd().endsWith("질문입니다"), "질문이 맨 뒤가 아니면 캐시 경계가 흐려진다");
    assert.ok(!SYSTEM.includes("크레딧 잔액: 120개"));
  });

  it("도움말이 비어도 그 사실을 말한다 — 빈 칸이면 모델이 지어낸다", () => {
    assert.match(turnContext("현황", "", null, "질문"), /관련 문서를 찾지 못했다/);
  });
});

describe("현황 스냅샷", () => {
  it("문장으로 나오고, 화면을 모르면 그 줄이 없다", () => {
    const base = {
      workspace: "테스트방송", role: "member" as const, credits: 120,
      channels: { youtube: 2, facebook: 0, instagram: 0, tiktok: 0, naver: 0 },
      analyzing: 1, failedJobs7d: 0, failedDistributions: 3, programs: 4,
    };
    const withScreen = snapshotText({ ...base, screen: "/automation" });
    assert.match(withScreen, /크레딧 잔액: 120개/);
    assert.match(withScreen, /youtube 2개/);
    assert.match(withScreen, /지금 보고 있는 화면: \/automation/);

    const noScreen = snapshotText({ ...base, screen: null });
    assert.doesNotMatch(noScreen, /지금 보고 있는 화면/);
  });

  it("연결된 채널이 없으면 '없음' 이라고 말한다 — 빈 문자열로 두면 모델이 지어낸다", () => {
    const text = snapshotText({
      workspace: "테스트", role: "owner", credits: 0,
      channels: { youtube: 0, facebook: 0, instagram: 0, tiktok: 0, naver: 0 },
      analyzing: 0, failedJobs7d: 0, failedDistributions: 0, programs: 0, screen: null,
    });
    assert.match(text, /연결된 채널: 없음/);
  });
});
