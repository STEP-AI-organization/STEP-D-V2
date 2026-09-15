import type { AppHono } from "../app-env.ts";
import { ask as chatbotAsk, ChatbotError } from "./agent.ts";
import {
  deleteThread as chatDeleteThread, getThread as chatGetThread,
  listMessages as chatListMessages, listThreads as chatListThreads,
} from "./store.ts";
import { chatbotActor, chatbotStatus } from "./actor.ts";

// ── 챗봇 (업무 도우미) ────────────────────────────────────────────────────────
//
// 세션이 있어야 한다(`requireUser`) — 챗봇은 **그 사람의 워크스페이스 상태**를 읽어 답하고,
// 대화도 사람 단위로 남는다. API 키(회사 단위)로 열지 않는 이유가 그것이다.
//
// 스트리밍하지 않는다. 프로덕션 웹은 `/api/proxy` 를 거치므로 서버가 보내는 바이트가 그대로
// 과금되는데(2026-08-31 하루 276GB 사고), 1~3초짜리 응답에 SSE 를 붙일 값이 없다.

export function registerChatbotRoutes(app: AppHono): void {
  app.post("/api/chatbot/message", async (c) => {
    const user = chatbotActor(c);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    try {
      const out = await chatbotAsk({
        user,
        threadId: typeof body.threadId === "string" ? body.threadId : null,
        message: String(body.message ?? ""),
        screen: typeof body.screen === "string" ? body.screen : null,
      });
      return c.json(out);
    } catch (e) {
      if (e instanceof ChatbotError) return c.json({ error: e.code, message: e.message }, chatbotStatus(e.code));
      throw e;
    }
  });

  app.get("/api/chatbot/threads", async (c) => {
    const user = chatbotActor(c);
    return c.json({ threads: await chatListThreads(user) });
  });

  app.get("/api/chatbot/threads/:id", async (c) => {
    const user = chatbotActor(c);
    const thread = await chatGetThread(user, c.req.param("id"));
    // 남의 대화와 없는 대화를 **같은 응답으로** 다룬다 — 존재 여부도 알려 주지 않는다.
    if (!thread) return c.json({ error: "not_found", message: "대화를 찾을 수 없습니다." }, 404);
    return c.json({ thread, messages: await chatListMessages(thread.id) });
  });

  app.delete("/api/chatbot/threads/:id", async (c) => {
    const user = chatbotActor(c);
    const ok = await chatDeleteThread(user, c.req.param("id"));
    if (!ok) return c.json({ error: "not_found", message: "대화를 찾을 수 없습니다." }, 404);
    return c.json({ ok: true });
  });
}
