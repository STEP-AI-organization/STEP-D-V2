import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **GCS 경로를 URL 파라미터로 조립하는 라우트는 소유자를 먼저 확인해야 한다.**
 *
 * 이 리포의 워크스페이스 격리는 Postgres RLS 가 담당한다 — 쿼리에 `tenant_id` 조건이 없어도
 * 정책이 행을 걸러낸다. 그래서 대부분의 라우트는 따로 검사를 안 해도 안전하다.
 *
 * ⚠️ **그 전제가 성립하지 않는 라우트가 있다.** `analysis/{mediaId}/…` 처럼 오브젝트 경로를
 * URL 파라미터로 **직접 조립**해 파일을 흘리는 라우트는 DB 를 아예 안 타므로 RLS 가 개입할
 * 지점이 없다. 실측(2026-08-31 감사): scene_frames·face_clusters·faces.json·ppl_frames·
 * ppl.json 다섯 라우트가 `getMedia()` 없이 열려 있었고, **외부 고객사 API 키에도 열린
 * 경로**였다(`api-keys.ts` 화이트리스트). mediaId 하나만 알면 남의 회차 산출물을 순번으로
 * 열거해 받아갈 수 있었다.
 *
 * `getMedia()` 호출이 그 지점을 만든다 — RLS 가 남의 행을 안 주므로 404 가 된다.
 * 그래서 이 테스트는 **"경로를 조립하면 소유자를 확인한다"** 를 강제한다.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");

/** `app.get("/api/media/:id/…", …)` 한 개의 본문을 통째로 떠낸다. */
function mediaRoutes(): { decl: string; body: string }[] {
  const out: { decl: string; body: string }[] = [];
  const re = /^app\.(get|post|put|patch|delete)\("(\/api\/media\/:id\/[^"]*)"[\s\S]*?\n\}\);/gm;
  for (const m of src.matchAll(re)) out.push({ decl: m[2], body: m[0] });
  return out;
}

describe("미디어 오브젝트 라우트 — 경로를 조립하면 소유자를 확인한다", () => {
  const routes = mediaRoutes();

  it("라우트를 실제로 떠낸다 (정규식이 죽으면 이 테스트 전체가 무의미해진다)", () => {
    assert.ok(routes.length >= 15, `/api/media/:id/* 라우트가 ${routes.length}개뿐 — 파싱 실패 의심`);
  });

  it("analysis/{id}/… 를 조립하는 라우트는 전부 getMedia 를 부른다", () => {
    const offenders = routes
      .filter((r) => /`analysis\/\$\{id\}\//.test(r.body) || /`analysis\/\$\{mediaId\}\//.test(r.body))
      .filter((r) => !/getMedia\(/.test(r.body))
      .map((r) => r.decl);
    assert.deepEqual(offenders, [],
      `소유자 확인 없이 GCS 경로를 흘리는 라우트: ${offenders.join(" · ")}\n` +
      `→ 본문 첫머리에 \`if (!(await getMedia(id))) return c.json({ error: "media not found" }, 404);\``);
  });

  // ⚠️ 있기만 해선 부족하다 — 캐시 히트 분기에서 건너뛰면 경계가 사라진다.
  // `/segment` 가 정확히 그랬다: getMedia 가 `if (!(await fileExists(objPath))) {` **안**에 있어서
  // 이미 잘려 저장된 구간은 확인 없이 나갔다.
  it("소유자 확인이 파일 존재 확인보다 **먼저** 온다", () => {
    for (const r of routes) {
      if (!/getMedia\(/.test(r.body) || !/fileExists\(/.test(r.body)) continue;
      const gm = r.body.indexOf("getMedia(");
      const fe = r.body.indexOf("fileExists(");
      assert.ok(gm < fe,
        `${r.decl}: getMedia 가 fileExists 뒤에 있다 — 캐시가 있으면 소유자 확인을 건너뛴다`);
    }
  });
});
