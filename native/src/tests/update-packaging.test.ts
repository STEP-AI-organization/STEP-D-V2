/**
 * 자동 업데이트가 **실제로 배달되는 모양인가** — 패키징 설정 검사.
 *
 * 이 층의 실패는 전부 조용하다. 설정 한 줄이 어긋나면 앱은 멀쩡히 돌고, 업데이트만
 * 영원히 안 온다. 편집자는 그걸 알 방법이 없다(그동안도 수동 재설치였으니 이상하지도
 * 않다). 그래서 여기서 고정한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const NATIVE = path.resolve(import.meta.dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(NATIVE, "package.json"), "utf-8"));
const read = (...p: string[]) =>
  fs.readFileSync(path.join(NATIVE, ...p), "utf-8").replace(/\r\n/g, "\n");

describe("업데이트 피드 설정", () => {
  it("publish 가 있다 — 없으면 electron-builder 가 latest.yml 을 안 만든다", () => {
    const pub = pkg.build?.publish;
    assert.ok(Array.isArray(pub) && pub.length === 1, "build.publish 가 없다 — 업데이트가 통째로 안 돈다");
    assert.equal(pub[0].provider, "generic");
    assert.match(String(pub[0].url ?? ""), /^https:\/\//, "피드가 https 가 아니다");
  });

  it("피드 주소와 앱이 보는 주소가 같다 — 갈리면 영원히 최신이라고 나온다", () => {
    const url = String(pkg.build.publish[0].url);
    assert.ok(read("src", "update", "updater.ts").includes(url),
      `updater.ts 의 기본 피드가 package.json(${url})과 다르다`);
  });

  it("**종료 시 자동 설치를 끈다** — 이 앱의 종료는 하필 제일 바쁜 순간에 온다", () => {
    // 전송을 다 마치면 앱이 스스로 꺼진다(closeWhenIdle). 기본값이면 그때 설치가 걸린다.
    assert.match(read("src", "update", "updater.ts"), /autoUpdater\.autoInstallOnAppQuit = false/);
  });

  it("프리릴리스를 안 받는다 — 실수로 올라간 베타가 전 PC 로 퍼지지 않게", () => {
    assert.match(read("src", "update", "updater.ts"), /autoUpdater\.allowPrerelease = false/);
  });

  it("차등 업데이트가 켜져 있다 — 동봉 ffmpeg 때문에 설치본이 100MB 를 넘는다", () => {
    assert.equal(pkg.build.nsis.differentialPackage, true);
  });

  /**
   * `perMachine: false` 는 편의가 아니라 **자동 업데이트의 전제**다. 관리자 설치면
   * 갱신마다 UAC 가 뜨고, 무인 설치가 거기서 멈춘다 — 편집자는 아무것도 못 본 채
   * 업데이트가 안 되는 상태가 된다.
   */
  it("사용자 설치를 유지한다 — 관리자 설치면 갱신마다 UAC 에서 멈춘다", () => {
    assert.equal(pkg.build.nsis.perMachine, false);
    assert.equal(pkg.build.nsis.allowElevation, false);
  });
});

describe("electron-updater 를 실제로 실을 수 있나", () => {
  it("**dependencies 에 있다** — devDependencies 면 설치본에 안 들어간다", () => {
    assert.ok(pkg.dependencies?.["electron-updater"],
      "electron-updater 가 dependencies 에 없다 — 패키징에서 빠져 앱이 기동하다 죽는다");
  });

  it("번들하지 않는다 — asar 밖 경로 추정이 깨진다", () => {
    assert.match(read("scripts", "build.mjs"), /external: \["electron", "electron-updater"\]/);
  });
});

describe("URL 스킴 — 등록한 것을 실제로 처리하나", () => {
  const main = read("src", "main.ts");

  it("설치 매니페스트와 코드가 같은 스킴을 말한다", () => {
    const declared: string[] = pkg.build.protocols[0].schemes;
    const inCode = /const PROTOCOLS = \[([^\]]+)\]/.exec(main)?.[1] ?? "";
    for (const s of declared) {
      assert.ok(inCode.includes(`"${s}"`),
        `설치본은 ${s}:// 를 등록하는데 코드의 PROTOCOLS 에 없다`);
    }
    assert.ok(declared.includes("stepaistudio"), "새 이름이 설치 매니페스트에 없다");
    assert.ok(declared.includes("stepd"), "옛 이름을 뺐다 — 이미 깔린 PC 의 딥링크가 죽는다");
  });

  /**
   * 실제로 이랬다: `PROTOCOLS` 는 둘 다 등록하는데 `handleProtocol` 이 `stepd:` 만
   * 통과시켜서, `stepaistudio://app/...` 이 OS 를 거쳐 앱까지 와서 **조용히 버려졌다.**
   * 눌러도 아무 일이 안 일어나는 증상이라 원인을 찾기 어렵다.
   */
  it("**받은 스킴을 버리지 않는다** — 등록만 하고 안 받으면 딥링크가 조용히 죽는다", () => {
    const fn = main.slice(main.indexOf("function handleProtocol("), main.indexOf("const PROTOCOLS"));
    assert.ok(!/url\.protocol !== "stepd:"/.test(fn),
      "handleProtocol 이 옛 스킴만 통과시킨다 — 새 이름 딥링크가 버려진다");
    assert.match(fn, /isOurProtocol\(/, "handleProtocol 이 등록 목록을 안 본다");
  });
});
