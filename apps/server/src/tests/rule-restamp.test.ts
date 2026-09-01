/**
 * 계획 모양이 바뀌면 **대기 중인 클립을 다시 찍는다** — 2026-08-28 ENA 실사고에서 나온 요구.
 *
 * 사고 형태: 계획에서 템플릿·색·글꼴을 바꿨는데 이미 채택·렌더된 11건은 `editorState` 가
 * 채택 시점에 굳어 있어 **옛 모양 그대로 고객 채널에 나갈 뻔했다.** 화면에서는 바꿨으니
 * 사용자는 바뀐 줄 안다 — 이 리포 최빈 실패모드("저장은 됐는데 반영이 안 된다")의 전형이다.
 *
 * 그래서 이 파일은 셋을 고정한다:
 *   ① 모양이 **진짜** 바뀌었을 때만 다시 찍는다(안 그러면 켜고 끄기만 해도 전량 재인코딩)
 *   ② **대기 중인 것만** 건드린다(이미 나간 건 채널과 DB 가 갈라진다)
 *   ③ 사람이 편집기에서 정한 값은 **보존**한다(계획 변경이 남의 편집을 지우면 안 된다)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { isPending, layoutFingerprint, mergeRestamped, PRESERVED_KEYS } from "../rule-restamp.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

describe("모양 지문 (layoutFingerprint)", () => {
  it("키 순서가 달라도 같은 모양이면 같은 지문 — 아니면 저장할 때마다 전량 재렌더된다", () => {
    const a = { templateId: "broadcast-standard", layout: { titleColor: "#f0e800", titleY: 11 } };
    const b = { templateId: "broadcast-standard", layout: { titleY: 11, titleColor: "#f0e800" } };
    assert.equal(layoutFingerprint(a), layoutFingerprint(b));
  });

  it("색·글꼴·템플릿이 바뀌면 지문이 바뀐다", () => {
    const base = { templateId: "broadcast-standard", layout: { titleColor: "#f0e800" } };
    assert.notEqual(layoutFingerprint(base),
      layoutFingerprint({ ...base, layout: { titleColor: "#40E0E0" } }));
    assert.notEqual(layoutFingerprint(base),
      layoutFingerprint({ ...base, layout: { titleColor: "#f0e800", titleFont: "gmarket" } }));
    assert.notEqual(layoutFingerprint(base),
      layoutFingerprint({ ...base, templateId: "broadcast-drama" }));
  });

  it("모양과 무관한 변경(켜기·할당량·슬롯)은 지문을 바꾸지 않는다 — 재렌더 낭비 방지", () => {
    const base: any = { templateId: "t", layout: { titleColor: "#f0e800" } };
    const noisy: any = { ...base, enabled: false, dailyQuota: 10, slots: [{ time: "18:00", count: 10 }] };
    assert.equal(layoutFingerprint(base), layoutFingerprint(noisy));
  });

  it("계획이 없으면(신규 생성) 빈 지문 — 기존 것과 항상 다르다", () => {
    assert.equal(layoutFingerprint(undefined), "");
    assert.notEqual(layoutFingerprint(undefined), layoutFingerprint({ templateId: "t" }));
  });
});

describe("대기 판정 (isPending)", () => {
  it("배포 행이 없으면 대기 — 다시 찍어도 된다", () => {
    assert.equal(isPending({}), true);
    assert.equal(isPending({ distributions: [] }), true);
  });

  it("한 채널이라도 나갔으면 손대지 않는다 — 채널과 DB 가 갈라진다", () => {
    assert.equal(isPending({ distributions: [{ channel: "youtube" }] }), false);
  });
});

describe("다시 찍기 병합 (mergeRestamped)", () => {
  const prev = {
    titleLines: [{ id: "t0", text: "옛 제목", color: "#40E0E0" }],
    captionColor: "#FFFFFF",
    trimIn: 1.5, trimOut: 20, hookOn: true, hookCaption: "사람이 고친 훅",
  };
  const fresh = {
    titleLines: [{ id: "t0", text: "옛 제목", color: "#f0e800", font: "gmarket" }],
    captionColor: "#f2cd69",
  };

  it("계획의 모양(색·글꼴·자막)은 새 값으로 갈린다", () => {
    const out = mergeRestamped(prev, fresh) as any;
    assert.equal(out.titleLines[0].color, "#f0e800");
    assert.equal(out.titleLines[0].font, "gmarket");
    assert.equal(out.captionColor, "#f2cd69");
  });

  it("사람이 편집기에서 정한 값은 그대로 — 계획 변경이 남의 편집을 지우면 안 된다", () => {
    const out = mergeRestamped(prev, fresh) as any;
    assert.equal(out.trimIn, 1.5);
    assert.equal(out.trimOut, 20);
    assert.equal(out.hookOn, true);
    assert.equal(out.hookCaption, "사람이 고친 훅");
  });

  it("보존 목록에 트림·훅이 들어 있다", () => {
    for (const k of ["trimIn", "trimOut", "hookOn", "hookCaption"]) {
      assert.ok((PRESERVED_KEYS as readonly string[]).includes(k), `${k} 가 보존 목록에 없다`);
    }
  });

  it("이전 상태가 없어도 새 시드를 그대로 돌려준다", () => {
    assert.deepEqual(mergeRestamped(undefined, fresh), fresh);
  });
});

describe("배선 (소스 스캔)", () => {
  const idx = read("index.ts");
  const mod = read("rule-restamp.ts");

  it("갱신 **전에** 옛 모양을 읽는다 — 뒤에 읽으면 늘 같아서 영영 안 돈다", () => {
    const beforeAt = idx.indexOf("const before = (await listAutomationRules())");
    const updateAt = idx.indexOf("const updated = await updateAutomationRuleById(");
    assert.ok(beforeAt > 0 && updateAt > 0, "갱신 경로를 찾지 못했다");
    assert.ok(beforeAt < updateAt, "옛 계획을 갱신 뒤에 읽고 있다 — 지문 비교가 무의미해진다");
  });

  it("모양이 바뀌었을 때만 다시 찍는다", () => {
    assert.match(idx, /if \(shapeChanged\) \{[\s\S]{0,200}restampPendingClips\(row as any\)/);
  });

  it("다시 찍기 실패가 계획 저장을 되돌리지 않는다 — 저장은 이미 끝났다", () => {
    assert.match(idx, /계획 모양 변경 후 대기 클립 재적용 실패/);
  });

  it("몇 건을 다시 찍었는지 응답에 실어 준다 — 조용하면 반영 여부를 알 길이 없다", () => {
    assert.match(idx, /\brestamped,\r?\n/);
  });

  it("재렌더 대기로 되돌린다 — rendered:false 가 없으면 옛 파일이 그대로 나간다", () => {
    assert.match(mod, /rendered: false,/);
  });

  it("이미 나간 클립은 대상에서 뺀다", () => {
    assert.match(mod, /const targets = mine\.filter\(isPending\);/);
  });

  it("순방과 같은 로고 기본값을 쓴다 — 다르면 '다시 찍었더니 처음과 모양이 다르다'", () => {
    assert.match(mod, /if \(layout\.logo === undefined\) layout\.logo = false;/);
    assert.match(read("automation-cycle.ts"), /logo: \(rule as any\)\.layout\?\.logo \?\? false/);
  });
});

/**
 * 렌더를 큐로 넘겼을 때 **실패가 순방으로 돌아오는가** (2026-08-31).
 *
 * 직접 호출 시절엔 응답이 곧 결과였다. 큐로 옮기면 "넣었다" 와 "됐다" 가 갈라지고, 그 사이가
 * 비면 순방은 성공으로 알고 매 틱 다시 넣는다 — 안전벨트(nextAutoRenderState)는 한 번도
 * 안 걸리고, 사람은 사유를 못 본 채 클립이 영영 안 나간다. **이 리포 최빈 실패모드의 변종**이다.
 */
describe("렌더 큐 — 넣은 일의 결과를 되읽는다", () => {
  const src = read("automation-cycle.ts");

  it("지난 잡이 failed 면 그 실패를 순방에 돌려준다 — 성공으로 치지 않는다", () => {
    assert.match(src, /lastJobByDedupe\("clip\.render", dedupeKey\)/);
    assert.match(src, /if \(last\?\.status === "failed"\) \{/);
    assert.match(src, /return \{ ok: false, kind: classifyRenderFailure\(status, code\)/);
  });

  it("실패를 **직접 호출과 같은 분류**에 태운다 — 두 경로가 다른 판정을 내리면 안 된다", () => {
    // 잡 오류 문자열에서 상태코드·코드를 되살린다(핸들러가 `export {status} {body}` 로 던진다).
    assert.ok(src.includes(String.raw`/export (\d{3})/`), "상태코드 파싱이 없다");
    assert.ok(src.includes("(?:code|error)"), "라우트가 준 코드 파싱이 없다");
  });

  it("결과 확인이 **넣기 전**에 온다 — 뒤에 있으면 방금 넣은 pending 을 보게 된다", () => {
    const readAt = src.indexOf('lastJobByDedupe("clip.render", dedupeKey)');
    const enqAt = src.indexOf('await enqueue("clip.render"');
    assert.ok(readAt > 0 && enqAt > 0);
    assert.ok(readAt < enqAt, "실패 회수가 enqueue 뒤에 있으면 실패를 영영 못 읽는다");
  });

  it("워커 핸들러는 실패를 던진다 — 삼키면 잡이 done 이 되어 회수할 실패가 없다", () => {
    const worker = read("worker.ts");
    assert.match(worker, /throw new Error\(`export \$\{res\.status\} \$\{body\.slice\(0, 200\)\}`\)/);
  });
});
