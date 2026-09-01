/**
 * 네이버 로그인 도우미 ↔ 계정 연결 고정.
 *
 * 네이버는 공개 업로드 API 가 없어 사람이 브라우저로 로그인한 세션을 등록한다. 계정이 하나일
 * 땐 도우미가 알아서 그 하나를 골랐는데, **둘 이상이 되면 "어느 계정인가요?" 를 되묻고**
 * 거기서 잘못 고르면 A 계정 세션이 B 계정 밑에 저장된다 — 서버는 그 쿠키가 어느 네이버
 * 아이디 건지 모르니 아무도 못 잡는다(2026-08-19 사용자 지적).
 *
 * 그래서 웹 카드에서 고른 계정이 **다운로드 파일명**을 타고 도우미까지 따라간다. exe 는 URL
 * 파라미터를 못 받으니 파일 자체에 싣는 것이고, 그러면 나중에 실행해도·여러 개를 받아둬도
 * 안 헷갈린다. 이 연결은 세 파일에 걸쳐 있어(웹 링크 → 라우트 → 도우미) 한 군데만 바뀌어도
 * 조용히 옛 동작으로 돌아간다 — 소스 스캔으로 고정한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
const TOOL = fs.readFileSync(path.resolve(SRC, "../scripts/naver-login-tool.mts"), "utf-8");
const STORAGE = fs.readFileSync(path.join(SRC, "storage-gcs.ts"), "utf-8");
const WEB = fs.readFileSync(
  path.resolve(SRC, "../../web/src/components/publish/naver-accounts.tsx"), "utf-8");

/** 도우미가 실행파일 이름에서 계정 키를 뽑는 규칙 — 소스에서 정규식을 읽어 그대로 검증한다. */
function exeNameRegex(): RegExp {
  const m = /return (\/\(nva_\[a-z0-9\]\+\)\/i)\.exec/.exec(TOOL);
  assert.ok(m, "도우미의 파일명 파싱 정규식을 못 찾았다 — 규칙이 바뀌었는지 확인");
  return /(nva_[a-z0-9]+)/i;
}

describe("로그인 도우미는 웹에서 고른 계정을 따라간다", () => {
  it("웹 카드가 account 를 붙여 내려받는다", () => {
    assert.match(WEB, /naver\/login-tool\?account=\$\{encodeURIComponent\(a\.id\)\}/,
      "카드 링크에 account 가 없으면 받은 파일이 어느 계정인지 알 수 없다 — 도우미가 되묻는다");
  });

  it("라우트가 계정을 검증하고 파일명에 accountKey 를 박는다", () => {
    assert.match(INDEX, /stepd-naver-login--\$\{acct\.accountKey\}\.exe/,
      "파일명에 계정 키를 안 실으면 웹의 선택이 도우미까지 도달하지 않는다");
    // 없는/남의 계정 키가 파일명에 박히면 도우미가 엉뚱한 곳에 세션을 올린다.
    assert.match(INDEX, /const acct = await getNaverAccount\(accountId\);\s*\n\s*if \(!acct\) return c\.json\(\{ error: "not_found"/,
      "계정 검증 없이 파일명을 만들면 안 된다");
  });

  it("서명 URL 이 그 파일명을 강제한다 (Content-Disposition)", () => {
    assert.match(STORAGE, /responseDisposition: `attachment; filename="/,
      "signedReadUrl 이 파일명을 안 실으면 GCS 오브젝트 이름(stepd-naver-login.exe)으로 저장된다");
  });

  it("도우미가 --account 없이도 실행파일 이름에서 계정을 읽는다", () => {
    assert.match(TOOL, /const accountArg = arg\("--account"\) \?\? accountKeyFromExeName\(\)/,
      "파일명 폴백이 없으면 웹에서 받은 파일도 계정을 되묻는다");
    assert.match(TOOL, /path\.basename\(process\.execPath\)/,
      "자기 실행파일 이름을 안 보면 파일명에 실은 계정이 소비되지 않는다");
  });

  it("파일명 규칙이 실제 이름들에 맞는다 (브라우저 중복 접미사 포함)", () => {
    const re = exeNameRegex();
    assert.equal(re.exec("stepd-naver-login--nva_abc123def.exe")?.[1], "nva_abc123def");
    // 같은 계정 도우미를 두 번 받으면 윈도우가 " (1)" 을 붙인다 — 그래도 읽혀야 한다.
    assert.equal(re.exec("stepd-naver-login--nva_abc123def (1).exe")?.[1], "nva_abc123def");
    // 계정 없이 받은 옛 파일·개발 실행(bun/node)은 못 읽어야 한다 → 물어보는 폴백으로 간다.
    assert.equal(re.exec("stepd-naver-login.exe"), null);
    assert.equal(re.exec("bun.exe"), null);
  });

  it("계정 키가 목록에 없으면 진행하지 않는다 — 엉뚱한 계정에 올리느니 멈춘다", () => {
    assert.match(TOOL, /찾을 수 없습니다 — 삭제됐거나 사용 중지됐습니다/,
      "삭제된 계정 키로 받은 파일을 그냥 진행시키면 안 된다");
  });

  it("어느 계정에 붙는지 사람에게 보여준다 (자동 선택이든 수동 선택이든)", () => {
    assert.match(TOOL, /② 계정: \$\{hit\.label\}/, "자동 선택한 계정 이름을 안 찍으면 확인할 방법이 없다");
    assert.match(TOOL, /선택: \$\{usable\[n - 1\]\.label\}/, "수동 선택도 고른 이름을 되짚어줘야 한다");
  });
});
