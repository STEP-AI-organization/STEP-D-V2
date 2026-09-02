/**
 * 자동배포 리포트 수신자 — **여러 명**(2026-09-02).
 *
 * 이 파일이 막는 실패는 둘인데, 둘 다 조용하다:
 *  1. **하위호환.** 이미 저장된 워크스페이스의 값은 단일 문자열(`a@x.com`)이다. 배열만 읽게
 *     만들면 지금 리포트를 받던 담당자가 아무 신호 없이 빠진다 — 메일이 "안 오는" 것으로만
 *     드러나고, 안 오는 건 눈에 안 띈다.
 *  2. **소비처 누락.** 같은 키를 결제 경고(billing-notify)가 폴백으로 읽는다. 생산자만 바꾸고
 *     소비처를 빼먹는 게 이 리포 최빈 실패모드라, 소스 스캔으로 함께 고정한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  NOTIFY_EMAIL_MAX, isNotifyEmail, parseNotifyEmails, serializeNotifyEmails,
} from "../pipeline/automation.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.resolve(SRC, p), "utf-8");

describe("수신자 파싱 — 옛 저장값이 그대로 읽혀야 한다", () => {
  it("단일 문자열(구 저장값)은 한 명으로 읽힌다", () => {
    assert.deepEqual(parseNotifyEmails("a@x.com"), ["a@x.com"]);
    assert.deepEqual(parseNotifyEmails("  a@x.com  "), ["a@x.com"]);
  });

  it("JSON 배열(신규 저장값)을 읽는다", () => {
    assert.deepEqual(parseNotifyEmails('["a@x.com","b@y.com"]'), ["a@x.com", "b@y.com"]);
  });

  it("쉼표·세미콜론 목록도 받는다 — 예전엔 이게 400 이었다", () => {
    assert.deepEqual(parseNotifyEmails("a@x.com, b@y.com"), ["a@x.com", "b@y.com"]);
    assert.deepEqual(parseNotifyEmails("a@x.com;b@y.com"), ["a@x.com", "b@y.com"]);
  });

  it("빈 값·공백은 수신자 없음 — 알림을 아예 안 보내는 쪽으로 떨어진다", () => {
    for (const v of ["", "   ", null, undefined]) assert.deepEqual(parseNotifyEmails(v), []);
  });

  it("형식이 아닌 항목만 버리고 나머지는 살린다 — 한 줄 오타가 전체를 죽이지 않는다", () => {
    assert.deepEqual(parseNotifyEmails('["a@x.com","보내줘","b@y.com"]'), ["a@x.com", "b@y.com"]);
  });

  it("중복은 대소문자 무시로 제거한다 — 같은 사람에게 두 통 가지 않게", () => {
    assert.deepEqual(parseNotifyEmails('["a@x.com","A@X.com"]'), ["a@x.com"]);
  });

  it("깨진 JSON 은 수신자 없음 — 던지지 않는다(발송 경로는 절대 예외를 내면 안 된다)", () => {
    assert.deepEqual(parseNotifyEmails('["a@x.com"'), []);
  });

  it(`상한 ${NOTIFY_EMAIL_MAX}명을 넘기지 않는다 — 리포트는 담당자용이지 메일링 리스트가 아니다`, () => {
    const many = Array.from({ length: NOTIFY_EMAIL_MAX + 5 }, (_, i) => `u${i}@x.com`);
    assert.equal(parseNotifyEmails(JSON.stringify(many)).length, NOTIFY_EMAIL_MAX);
  });

  it("직렬화 왕복이 값을 보존한다 · 빈 목록은 빈 문자열(행 삭제 대신)", () => {
    const list = ["a@x.com", "b@y.com"];
    assert.deepEqual(parseNotifyEmails(serializeNotifyEmails(list)), list);
    assert.equal(serializeNotifyEmails([]), "");
  });

  it("isNotifyEmail 은 목록 문자열을 단일 주소로 착각하지 않는다", () => {
    assert.equal(isNotifyEmail("a@x.com"), true);
    assert.equal(isNotifyEmail("a@x.com,b@y.com"), false);
    assert.equal(isNotifyEmail(""), false);
    assert.equal(isNotifyEmail(null), false);
  });
});

describe("소비처가 전부 목록을 읽는다 — 하나라도 빠지면 조용히 한 명만 받는다", () => {
  it("발송 지점(publish-notify)이 parseNotifyEmails 로 읽고 쉼표로 이어 보낸다", () => {
    const src = read("publish/publish-notify.ts");
    assert.match(src, /parseNotifyEmails\(await getAutomationSetting\(NOTIFY_EMAIL_KEY\)\)/,
      "옛 단일 문자열 검증이 남아 있으면 여러 명을 저장해도 발송은 한 명이다");
    assert.match(src, /recipients\.join\(", "\)/,
      "nodemailer 에 목록을 넘기지 않으면 첫 사람에게만 간다");
    assert.doesNotMatch(src, /\^\[\^@\\s\]\+@/,
      "발송 지점에 단일 이메일 정규식이 남아 있다 — 잣대는 automation.ts 한 곳이어야 한다");
  });

  it("결제 경고 폴백(billing-notify)도 같은 함수를 쓴다", () => {
    const src = read("billing/billing-notify.ts");
    assert.match(src, /parseNotifyEmails\(await getAutomationSetting\(NOTIFY_EMAIL_KEY\)\)/,
      "여기가 단일 문자열만 읽으면 담당자를 늘려도 결제 경고는 첫 사람만 받는다");
  });

  it("저장 라우트가 신·구 입력 꼴을 모두 받는다 — 웹·서버 배포 시점이 다르다", () => {
    const src = read("index.ts");
    const route = /app\.post\("\/api\/automation\/notify-email"[\s\S]*?\n\}\);/.exec(src);
    assert.ok(route, "notify-email 저장 라우트를 찾지 못했다");
    assert.match(route![0], /Array\.isArray\(body\.emails\)/, "신규 배열 입력을 안 받는다");
    assert.match(route![0], /body\.email/, "옛 단수 입력을 안 받는다 — 배포 사이에 저장이 죽는다");
    assert.match(route![0], /notifyEmails: emails/, "응답에 목록이 없으면 화면이 저장 결과를 못 읽는다");
  });

  it("조회 라우트가 목록을 내려준다 — 생산자만 있고 소비처가 없으면 죽은 기능이다", () => {
    assert.match(read("index.ts"), /notifyEmails: parseNotifyEmails\(notifyEmail\)/);
  });
});
