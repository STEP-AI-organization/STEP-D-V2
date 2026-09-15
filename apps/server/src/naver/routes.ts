import type { AppHono } from "../app-env.ts";
import fs from "node:fs";

import { requireManager } from "../auth/admin.ts";
import {
  clearNaverCredential, clearNaverSessionBlob, deleteNaverAccount, getNaverAccount,
  getNaverCredentialState, listNaverAccounts, markNaverAccount, setNaverCredential,
  setNaverSessionBlob, upsertNaverAccount,
} from "../db-pg.ts";
import { fileExists, signedReadUrl, useGcs } from "../media/storage-gcs.ts";
import { enqueue } from "../pipeline/queue.ts";
import { CATEGORY_SOURCE, listCategories } from "./naver-categories.ts";
import { credStoreReady, maskNaverId, sealCredential } from "./naver-cred-store.ts";
import { looksLikeStorageState, sealSession, sessionStoreReady } from "./naver-session-store.ts";
import { naverSessionPath } from "./naver-session.ts";

// ── 네이버 계정 (B2B 다계정) ──────────────────────────────────────────────────
//
// 실제 브라우저 자동화는 워커 PC(윈도우2)가 한다 — 서버는 "어느 고객사의 어떤 채널을
// 쓸 것인가" 라는 메타와, 봉인된 세션·자격증명의 **보관**만 맡는다.
//
// ⚠️ 세션(`session_blob`)과 자격증명(`cred_blob`)은 **어떤 응답에도 싣지 않는다.**
// 바깥으로 나가는 건 "있다/없다 + 상태 + 갱신시각" 뿐이다. 아래 라우트들이 응답 객체를
// 필드 단위로 직접 쓰는 이유가 그것 — 엔티티를 통째로 펼치면 언젠가 값이 새어 나간다.

export function registerNaverRoutes(app: AppHono): void {
  /**
   * 클립 카테고리 분류표. 화면이 자유입력 대신 드롭다운을 그리는 근거다.
   *
   * 자유입력이던 시절엔 목록에 없는 문자열이 들어와도 발행이 진행됐고, 브라우저 쪽에서
   * **첫 항목으로 조용히 대체**돼 엉뚱한 분류로 올라갔다. 고를 수 있는 값만 보여주면
   * 그 실수 자체가 없어진다.
   */
  app.get("/api/naver/categories", async (c) =>
    c.json({ categories: listCategories(), source: CATEGORY_SOURCE }));

  app.get("/api/naver/accounts", async (c) => {
    const accounts = await listNaverAccounts();
    return c.json({
      accounts: accounts.map((a) => ({
        id: a.id, label: a.label, accountKey: a.accountKey,
        target: a.target, status: a.status,
        lastLoginAt: a.lastLoginAt, lastPublishAt: a.lastPublishAt,
        // **있다/없다 + 언제** 만 나간다. 세션 값은 어떤 경우에도 응답에 싣지 않는다.
        hasSession: a.sessionUpdatedAt != null,
        sessionUpdatedAt: a.sessionUpdatedAt,
        // 워커 PC 에서 실행할 명령을 그대로 준다 — 운영자가 옮겨 적다 틀리지 않게.
        loginCommand: `pnpm --filter @stepd/server naver:login --account ${a.accountKey}`,
      })),
      // 키가 없으면 세션 업로드가 503 이다. 화면이 "올려도 안 되는 버튼"을 띄우지 않게 미리 알려준다.
      sessionStoreReady: sessionStoreReady(),
    });
  });

  app.post("/api/naver/accounts", async (c) => {
    requireManager(c);
    const b = await c.req.json<{ label?: string; target?: string }>().catch(() => null);
    const label = b?.label?.trim();
    if (!label) return c.json({ error: "label required" }, 400);
    const target = ["clip", "tv", "both"].includes(String(b?.target)) ? String(b?.target) : "both";

    // accountKey 는 **우리가 발급하는 불투명 키**다. 네이버 아이디를 받지 않는다 —
    // 파일 경로·로그·DB 에 고객사 계정 아이디가 박히면 안 된다.
    const id = `nva_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const accountKey = id;
    await upsertNaverAccount({
      id, label, accountKey, target: target as "clip" | "tv" | "both",
      status: "session_expired",   // 로그인 전이라 아직 못 쓴다 — active 로 시작하면 거짓말이다
      lastLoginAt: null, lastPublishAt: null, createdAt: Date.now(),
    });
    return c.json({
      id, accountKey, label, target, status: "session_expired",
      loginCommand: `pnpm --filter @stepd/server naver:login --account ${accountKey}`,
      hint: "워커 PC 에서 위 명령을 실행해 로그인해야 발행이 가능합니다.",
    });
  });

  app.patch("/api/naver/accounts/:id", async (c) => {
    requireManager(c);
    const id = c.req.param("id");
    const acct = await getNaverAccount(id);
    if (!acct) return c.json({ error: "not_found" }, 404);
    const b = await c.req.json<{ status?: string; label?: string; target?: string }>().catch(() => null);
    const status = ["active", "session_expired", "disabled"].includes(String(b?.status))
      ? (String(b?.status) as "active" | "session_expired" | "disabled") : undefined;
    const target = ["clip", "tv", "both"].includes(String(b?.target))
      ? (String(b?.target) as "clip" | "tv" | "both") : undefined;
    const label = b?.label?.trim() || undefined;
    if (!status && !target && !label) {
      return c.json({ error: "nothing_to_update", message: "status·label·target 중 하나는 있어야 합니다." }, 400);
    }
    await markNaverAccount(id, { status, label, target });
    const after = await getNaverAccount(id);
    return c.json({ ok: true, id, status: after?.status, label: after?.label, target: after?.target });
  });

  /**
   * 계정 삭제. 세션도 같은 행이라 함께 사라진다.
   * ⚠️ 워커 PC 에 남은 로컬 세션 파일까지는 못 지운다 — 서버에서 닿지 않는 머신이다.
   */
  app.delete("/api/naver/accounts/:id", async (c) => {
    requireManager(c);
    const id = c.req.param("id");
    const acct = await getNaverAccount(id);
    if (!acct) return c.json({ error: "not_found" }, 404);
    await deleteNaverAccount(id);
    return c.json({ ok: true, id });
  });

  /**
   * 세션 등록 — 운영자가 로그인해서 얻은 storageState 를 올린다.
   *
   * 사용자 관점에서는 **로그인 한 번이면 끝**이다: 계정 추가 → 로그인 → 여기로 세션이 올라오면
   * 워커가 어느 머신에서든 받아 쓴다. 윈도우2 앞에 갈 필요가 없어진다.
   *
   * ⚠️ 세션 쿠키는 그 계정의 전체 권한이다. 반드시 암호화해서 저장하고(NAVER_SESSION_KEY),
   *    키가 없으면 **거부한다** — 평문으로 조용히 저장되는 것보다 못 받는 게 낫다.
   */
  app.put("/api/naver/accounts/:id/session", async (c) => {
    // ⚠️ 세션 blob 은 그 계정의 **전체 권한**이다(naver-session-store.ts 헤더 참고).
    //    아이디·비번보다 즉시 쓸 수 있어 더 위험하다 — 관리자만.
    requireManager(c);
    const acct = await getNaverAccount(c.req.param("id"));
    if (!acct) return c.json({ error: "not_found" }, 404);
    if (!sessionStoreReady()) {
      return c.json({
        error: "session_key_missing",
        message: "NAVER_SESSION_KEY 가 설정되지 않아 세션을 저장할 수 없습니다(평문 저장은 하지 않습니다).",
      }, 503);
    }
    const body = await c.req.json<{ storageState?: unknown }>().catch(() => null);
    const state = body?.storageState;
    if (!looksLikeStorageState(state)) {
      return c.json({ error: "invalid_storage_state", message: "cookies 배열이 있는 storageState JSON 이어야 합니다." }, 400);
    }
    await setNaverSessionBlob(acct.id, sealSession(state));
    // 값은 절대 되돌려주지 않는다. 있다/없다만.
    return c.json({ ok: true, id: acct.id, status: "active", sessionUpdatedAt: Date.now() });
  });

  /**
   * 네이버 아이디·비번 저장 → **워커가 실제로 로그인해 검증**한다.
   *
   * 세션은 만료된다(실측: 9일). 만료마다 사람이 브라우저를 여는 게 이 기능의 원래 부담이었고,
   * 자격증명이 있으면 워커가 스스로 세션을 되살린다.
   *
   * ⚠️ 비밀번호는 세션보다 위험한 자산이다 — 다른 서비스에서도 통하고, 본인이 바꾸기 전엔
   *    무효화되지 않는다. 그래서 세션과 **다른 키**(NAVER_CRED_KEY)로 봉인하고, 관리자만,
   *    값은 어떤 응답에도 싣지 않는다. 검증 실패(비번 틀림)면 워커가 **지운다** —
   *    틀린 비번으로 반복 시도하면 계정이 잠긴다.
   */
  app.put("/api/naver/accounts/:id/credentials", async (c) => {
    requireManager(c);
    const acct = await getNaverAccount(c.req.param("id"));
    if (!acct) return c.json({ error: "not_found" }, 404);
    if (!credStoreReady()) {
      return c.json({
        error: "cred_key_missing",
        message: "NAVER_CRED_KEY 가 설정되지 않아 자격증명을 저장할 수 없습니다(평문 저장은 하지 않습니다).",
      }, 503);
    }
    const b = await c.req.json<{ id?: string; pw?: string }>().catch(() => null);
    const naverId = String(b?.id ?? "").trim();
    const naverPw = String(b?.pw ?? "");
    if (!naverId || !naverPw) {
      return c.json({ error: "bad_request", message: "아이디와 비밀번호가 모두 필요합니다." }, 400);
    }
    await setNaverCredential(acct.id, sealCredential({ id: naverId, pw: naverPw }));
    // 검증은 브라우저가 있는 워커(naver 레인)가 한다 — 여기서 로그인할 수 없다.
    const jobId = await enqueue("naver.login", { accountId: acct.id },
      { dedupeKey: `naver.login:${acct.id}` });
    // 값은 절대 되돌려주지 않는다. 가린 아이디만.
    return c.json({ ok: true, id: acct.id, maskedId: maskNaverId(naverId), status: "pending", jobId });
  });

  /** 자격증명 상태 조회 — 값은 안 나간다. 있다/없다·검증상태·사유만. */
  app.get("/api/naver/accounts/:id/credentials", async (c) => {
    const acct = await getNaverAccount(c.req.param("id"));
    if (!acct) return c.json({ error: "not_found" }, 404);
    const state = await getNaverCredentialState(acct.id);
    return c.json({ ...(state ?? { hasCred: false, status: null }), credKeyReady: credStoreReady() });
  });

  /** 자격증명 폐기. 세션은 남으므로 발행은 계속되고, 자동 재로그인만 꺼진다. */
  app.delete("/api/naver/accounts/:id/credentials", async (c) => {
    requireManager(c);
    const acct = await getNaverAccount(c.req.param("id"));
    if (!acct) return c.json({ error: "not_found" }, 404);
    await clearNaverCredential(acct.id);
    return c.json({ ok: true, id: acct.id });
  });

  /** 지금 다시 로그인 — 세션이 죽었을 때 사람이 눌러 되살린다(자격증명이 있어야 한다). */
  app.post("/api/naver/accounts/:id/relogin", async (c) => {
    requireManager(c);
    const acct = await getNaverAccount(c.req.param("id"));
    if (!acct) return c.json({ error: "not_found" }, 404);
    const state = await getNaverCredentialState(acct.id);
    if (!state?.hasCred) {
      return c.json({ error: "no_credentials", message: "저장된 아이디·비밀번호가 없습니다." }, 409);
    }
    const jobId = await enqueue("naver.login", { accountId: acct.id },
      { dedupeKey: `naver.login:${acct.id}` });
    return c.json({ ok: true, jobId });
  });

  app.delete("/api/naver/accounts/:id/session", async (c) => {
    requireManager(c);
    const acct = await getNaverAccount(c.req.param("id"));
    if (!acct) return c.json({ error: "not_found" }, 404);
    await clearNaverSessionBlob(acct.id);
    return c.json({ ok: true, id: acct.id, status: "session_expired" });
  });

  /** 워커 PC 에서만 의미 있는 진단 — 이 머신에 그 계정 세션 파일이 있는가. */
  app.get("/api/naver/accounts/:id/session", async (c) => {
    const acct = await getNaverAccount(c.req.param("id"));
    if (!acct) return c.json({ error: "not_found" }, 404);
    const p = naverSessionPath(acct.accountKey);
    return c.json({ id: acct.id, accountKey: acct.accountKey, present: fs.existsSync(p) });
  });

  // ── 로그인 도구(exe) 내려받기 ───────────────────────────────────────────────
  //
  // 원래는 `index.ts` 의 desktop 배포 라우트 사이에 떨어져 있었다. 경로가 `/api/naver/*` 이니
  // 네이버 도메인인데 물리적 위치만 엉뚱했던 것 — 분할하면서 이리로 모았다(2026-09-15).
  // 한 도메인이 두 곳에 흩어져 있으면 "폴더를 보면 찾을 수 있다" 는 분할의 목적이 사라진다.
  app.get("/api/naver/login-tool", async (c) => {
    const obj = "tools/stepd-naver-login.exe";
    if (!useGcs() || !(await fileExists(obj))) {
      return c.json({ error: "tool_not_uploaded", message: "도구가 아직 업로드되지 않았습니다 — 운영팀에 문의하세요." }, 404);
    }
    const accountId = (c.req.query("account") ?? "").trim();
    let name: string | undefined;
    if (accountId) {
      // getNaverAccount 은 RLS 스코프 안에서 도므로, 남의 워크스페이스 계정은 여기서 not_found 다.
      const acct = await getNaverAccount(accountId);
      if (!acct) return c.json({ error: "not_found", message: "계정을 찾을 수 없습니다." }, 404);
      name = `stepd-naver-login--${acct.accountKey}.exe`;
    }
    return c.redirect(await signedReadUrl(obj, 10 * 60_000, name));
  });
}
