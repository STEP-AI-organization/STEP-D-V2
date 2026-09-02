/**
 * 네이티브 ↔ 웹 경계 — **배포 결합이 조용히 늘어나지 않게** (사용자 2026-09-02:
 * "네이티브 기능이랑 웹 기능 확실히 분리 · 웹만 업데이트하면 끝인지 확실히").
 *
 * 이 리포에서 이 경계가 특별히 중요한 이유: **네이티브는 자동 업데이트가 없다**
 * (`build.publish` 가 null · electron-updater 미사용). 네이티브를 고치면 편집자 PC 마다
 * 사람이 `.exe` 를 다시 깐다. 그래서 결합면이 커지는 건 곧 운영 비용이다.
 *
 * 가장 조용한 실패: 웹의 버전 가드(`bridge.version !== 1`)와 브리지의 `version` 이 갈라지면
 * **아무 오류 없이** 브라우저 업로드로 떨어진다. 편집자는 "요즘 업로드가 느리고 창을 닫으면
 * 끊긴다" 로만 느끼고, 아무도 원인을 못 찾는다. 그 둘을 여기서 붙잡아 둔다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => fs.readFileSync(path.resolve(HERE, p), "utf-8");

const contract = read("contract.ts");
const preload = read("preload.ts");
const webGuard = read("../../apps/web/src/lib/native-transfers.tsx");

/** contract.ts 가 선언한 브리지 버전. 이 숫자가 배포 결합의 전부다. */
function contractVersion(): number {
  const m = /readonly version:\s*(\d+);/.exec(contract);
  assert.ok(m, "contract.ts 에서 브리지 version 선언을 못 찾았다");
  return Number(m![1]);
}

test("웹의 버전 가드와 브리지 version 이 같은 숫자다", () => {
  const v = contractVersion();
  const guard = /bridge\.version !== (\d+)/.exec(webGuard);
  assert.ok(guard, "웹에서 version 가드를 못 찾았다 — 없으면 옛 앱에서 런타임 오류가 난다");
  assert.equal(Number(guard![1]), v,
    `웹은 version ${guard![1]} 을 요구하는데 브리지는 ${v} 다 — 오류 없이 브라우저 업로드로 떨어진다`);
});

test("preload 가 선언한 version 도 같다 — 실제로 웹에 가는 값은 이쪽이다", () => {
  const m = /version:\s*(\d+),/.exec(preload);
  assert.ok(m, "preload.ts 에서 version 을 못 찾았다");
  assert.equal(Number(m![1]), contractVersion(),
    "타입은 1인데 실제로 넘기는 값이 다르면 타입 검사로는 안 잡힌다");
});

test("웹이 version 가드 없이 브리지를 쓰지 않는다", () => {
  // 가드가 사라지면 옛 앱에서 `bridge.newMethod is not a function` 이 난다.
  assert.match(webGuard, /if \(!bridge \|\| bridge\.version !== \d+\) return;/,
    "브리지 사용 전 가드가 없다");
});

test("브리지 표면이 예상 목록과 같다 — 늘리면 앱 재설치가 필요해진다", () => {
  // ⚠️ 이 목록을 고칠 때는 **왜 웹으로 못 하는지** 를 native/CLAUDE.md 에 함께 적을 것.
  // 메서드 추가는 웹 가드(숫자만 본다)를 그냥 통과하므로, 아직 안 깐 PC 에서
  // `bridge.<새 메서드> is not a function` 이 난다 — 앱을 **먼저** 깔아야 한다.
  const block = /export interface StepdNativeBridge \{([\s\S]*?)\n\}/.exec(contract);
  assert.ok(block, "StepdNativeBridge 선언을 못 찾았다");
  const methods = [...block![1].matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]).sort();
  assert.deepEqual(methods, [
    "cancelUpload",
    "clearCompleted",
    "enqueueUpload",
    "listUploads",
    "pauseUpload",
    "relinkUpload",
    "resumeUpload",
    "retryUpload",
    "subscribeUploads",
  ], "브리지 메서드가 바뀌었다 — 앱 재설치가 필요한 변경인지 확인하고 이 목록을 갱신할 것");
});

test("preload 는 신뢰 origin 에서만 브리지를 노출한다", () => {
  // 원격 웹을 그대로 띄우는 구조라, 여기가 뚫리면 아무 페이지나 네이티브 능력을 갖는다.
  assert.match(preload, /const trusted = origin === "https:\/\/stepd\.stepai\.kr"/);
  assert.match(preload, /if \(trusted\) \{/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("stepdNative", bridge\)/);
});

test("자동 업데이트가 없다는 사실이 문서와 일치한다", () => {
  // 이게 생기면 위 경계 규칙의 무게가 달라진다 — 문서를 같이 고쳐야 한다.
  const pkg = JSON.parse(read("../package.json")) as { build?: { publish?: unknown } };
  const doc = read("../CLAUDE.md");
  const hasPublish = pkg.build?.publish != null;
  assert.equal(hasPublish, false,
    "build.publish 가 생겼다 — 자동 업데이트를 도입했다면 native/CLAUDE.md 의 '재설치' 서술을 고칠 것");
  assert.match(doc, /자동 업데이트가 없다/);
});
