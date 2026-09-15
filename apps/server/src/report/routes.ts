import type { AppHono } from "../app-env.ts";
import { chatbotActor } from "../chatbot/actor.ts";
import { mailConfigured, sendMail } from "../mailer.ts";
import { buildReport, crosscheckFailures, toHtml } from "./index.ts";
import { getReport, listReports } from "./store.ts";

export function registerReportRoutes(app: AppHono): void {
  // ── 보고 리포트 ───────────────────────────────────────────────────────────────

  /**
   * 보고서 초안 생성. 대화를 거치지 않고 바로 부를 수도 있다(화면의 "보고서 만들기" 버튼).
   * 숫자는 전부 집계가 낳고 모델은 문장만 쓴다 — support/report/index.ts 주석 참고.
   */
  app.post("/api/reports", async (c) => {
    const user = chatbotActor(c);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const request = String(body.request ?? "").trim();
    if (!request) return c.json({ error: "request_required", message: "무엇을 뽑을지 적어 주세요." }, 400);
    if (request.length > 500) return c.json({ error: "too_long", message: "요청이 너무 깁니다." }, 400);

    const built = await buildReport(user, request, {
      threadId: typeof body.threadId === "string" ? body.threadId : null,
    });
    // 응답에 `data`(집계 원본)를 싣지 않는다 — 표를 다시 그릴 일이 없고, 그대로 실으면
    // 목록·재조회마다 수십 KB 가 프록시를 지난다. 필요하면 상세 조회에서 받는다.
    return c.json({
      reportId: built.reportId, spec: built.spec, markdown: built.markdown, warnings: built.warnings,
    });
  });

  app.get("/api/reports", async (c) => {
    const user = chatbotActor(c);
    return c.json({ reports: await listReports(user) });
  });

  app.get("/api/reports/:id", async (c) => {
    const user = chatbotActor(c);
    const r = await getReport(user, c.req.param("id"));
    if (!r) return c.json({ error: "not_found", message: "보고서를 찾을 수 없습니다." }, 404);
    return c.json(r);
  });

  /**
   * 내보내기. **검산이 어긋난 보고서는 파일로 나가지 않는다.**
   *
   * 화면에서는 보인다(무엇이 어긋났는지 알아야 고친다). 막는 것은 첨부파일이 되는 경로다 —
   * 한 번 파일이 되면 그게 회의 자료가 되고, 그 안의 합계가 표와 다르면 아무도 눈치채지 못한다.
   */
  app.get("/api/reports/:id/export", async (c) => {
    const user = chatbotActor(c);
    const r = await getReport(user, c.req.param("id"));
    if (!r) return c.json({ error: "not_found", message: "보고서를 찾을 수 없습니다." }, 404);

    const data = r.data;
    const failures = data?.crosscheck ? crosscheckFailures(data) : [];
    if (failures.length) {
      return c.json({
        error: "crosscheck_failed",
        message: `검산이 맞지 않아 내보낼 수 없습니다 — ${failures.join(" / ")}`,
      }, 409);
    }

    const format = c.req.query("format") === "html" ? "html" : "md";
    const stamp = `${r.spec?.from ?? ""}_${r.spec?.to ?? ""}`.replace(/[^0-9_-]/g, "");
    // 파일 이름에 한글을 쓰면 브라우저·메일 클라이언트마다 깨진다. 제목은 문서 안에 있다.
    const filename = `report_${stamp || r.id}.${format}`;
    const body = format === "html"
      ? toHtml(data, "", new Date(r.createdAt))
      : r.markdown;

    return new Response(body, {
      headers: {
        "content-type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  /** 메일로 보내기. SMTP 가 설정돼 있을 때만 — 없으면 조용히 성공한 척하지 않는다. */
  app.post("/api/reports/:id/email", async (c) => {
    const user = chatbotActor(c);
    if (!mailConfigured()) {
      return c.json({ error: "mail_not_configured", message: "메일 발송이 설정되지 않았습니다." }, 409);
    }
    const r = await getReport(user, c.req.param("id"));
    if (!r) return c.json({ error: "not_found", message: "보고서를 찾을 수 없습니다." }, 404);

    const data = r.data;
    const failures = data?.crosscheck ? crosscheckFailures(data) : [];
    if (failures.length) {
      return c.json({
        error: "crosscheck_failed",
        message: `검산이 맞지 않아 보낼 수 없습니다 — ${failures.join(" / ")}`,
      }, 409);
    }

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const raw: unknown[] = Array.isArray(body.to) ? body.to : [];
    const to = [...new Set(raw.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
    if (!to.length) return c.json({ error: "to_required", message: "받는 사람이 필요합니다." }, 400);
    if (to.length > 5) return c.json({ error: "too_many", message: "받는 사람은 5명까지입니다." }, 400);
    const bad = to.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) return c.json({ error: "invalid_email", message: `이메일 형식이 아닙니다: ${bad}` }, 400);

    const html = toHtml(data, "", new Date(r.createdAt));
    const subject = r.spec?.title ?? "보고서";
    const sent: string[] = [];
    for (const addr of to) {
      // 한 명이 실패해도 나머지는 보낸다 — 전부 되돌리면 이미 간 메일과 어긋난다.
      try { await sendMail({ to: addr, subject, html }); sent.push(addr); }
      catch (e) { console.warn(`[support] 리포트 메일 실패 (${addr}):`, e); }
    }
    if (!sent.length) return c.json({ error: "send_failed", message: "메일을 보내지 못했습니다." }, 502);
    return c.json({ ok: true, sent });
  });
}
