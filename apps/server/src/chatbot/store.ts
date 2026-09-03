/**
 * 챗봇 대화 저장소 (chat_thread · chat_message · 0051).
 *
 * 리포트는 여기 없다 — `report/store.ts` 가 갖는다. 두 기능이 표를 공유하지 않으므로
 * 폴더도 갈라 둔다(챗봇이 리포트를 부르는 한 방향 의존만 있다).
 *
 * ## 격리가 두 겹인 이유
 *
 *   회사(tenant) — **RLS 가 막는다.** 여기 SQL 에 tenant 조건이 하나도 없는 건 빠뜨린 게
 *                  아니라 정책이다(0014 이후 모든 표가 같다). 조건을 또 쓰면 격리가 두 벌이
 *                  되고, 한 벌만 고치는 날이 온다.
 *   사람(user)   — **이 파일이 조건에 넣는다.** 같은 회사 동료의 대화는 안 보여준다. 이건
 *                  보안이 아니라 정책이라 코드가 정하는 자리가 맞다(0051 주석).
 *
 * ## 대화를 왜 통째로 안 싣나
 *
 * 스레드가 길어지면 프롬프트가 무한정 자란다(= 원가가 대화 길이에 비례한다). 그래서 최근
 * 몇 개만 원문으로 싣고 그 이전은 **요약 한 덩어리**로 접는다. 접는 시점은 아래 상수 하나다.
 */
import { getPool } from "../db-pg.ts";
import { newId } from "../ids.ts";
import type { AnswerLink } from "./catalog.ts";

/** 프롬프트에 원문으로 싣는 최근 메시지 수(사용자+도우미 합). */
export const CONTEXT_MESSAGES = 12;
/**
 * 요약 갱신 주기(메시지 수). 컨텍스트 창을 넘긴 뒤부터 이 배수마다 한 번씩 다시 접는다 —
 * 매 턴 요약하면 호출이 두 배가 되고, 안 하면 창 밖의 맥락이 통째로 사라진다.
 */
export const SUMMARIZE_EVERY = 10;
/** 스레드 하나에 쌓을 수 있는 메시지 수. 넘으면 새 대화를 권한다. */
export const MAX_THREAD_MESSAGES = 200;
/** 목록에 보여주는 스레드 수. */
export const THREAD_LIST_LIMIT = 20;

export interface ThreadRow {
  id: string;
  title: string;
  summary: string | null;
  createdAt: number;
  lastMessageAt: number;
  messageCount?: number;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  links: AnswerLink[];
  usedDocs: string[];
  createdAt: number;
}

export interface Actor {
  id: string;
  tenantId: string;
}

// ── 스레드 ───────────────────────────────────────────────────────────────────────

export async function createThread(user: Actor, firstMessage: string): Promise<string> {
  const id = newId("th");
  const now = Date.now();
  await getPool().query(
    `INSERT INTO chat_thread (id, user_id, title, created_at, updated_at, last_message_at)
     VALUES ($1, $2, $3, $4, $4, $4)`,
    [id, user.id, threadTitle(firstMessage), now],
  );
  return id;
}

/**
 * 제목은 **첫 질문을 자른 것**이다. 모델에게 제목을 짓게 하면 호출이 한 번 더 늘고,
 * 목록에서 사람이 찾는 단서는 어차피 "내가 뭐라고 물었더라" 다.
 */
export function threadTitle(firstMessage: string): string {
  const one = String(firstMessage ?? "").replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 40)}…` : one || "새 대화";
}

/** 내 스레드만. 없는 스레드·남의 스레드는 똑같이 null 이다(존재 여부도 알리지 않는다). */
export async function getThread(user: Actor, threadId: string): Promise<ThreadRow | null> {
  const { rows } = await getPool().query(
    `SELECT id, title, summary, created_at AS "createdAt", last_message_at AS "lastMessageAt"
       FROM chat_thread WHERE id = $1 AND user_id = $2`,
    [threadId, user.id],
  );
  return rows[0] ? normalizeThread(rows[0]) : null;
}

export async function listThreads(user: Actor, limit = THREAD_LIST_LIMIT): Promise<ThreadRow[]> {
  const { rows } = await getPool().query(
    `SELECT t.id, t.title, t.summary, t.created_at AS "createdAt", t.last_message_at AS "lastMessageAt",
            (SELECT COUNT(*)::int FROM chat_message m WHERE m.thread_id = t.id) AS "messageCount"
       FROM chat_thread t
      WHERE t.user_id = $1
      ORDER BY t.last_message_at DESC
      LIMIT $2`,
    [user.id, Math.min(limit, THREAD_LIST_LIMIT)],
  );
  return rows.map(normalizeThread);
}

export async function deleteThread(user: Actor, threadId: string): Promise<boolean> {
  // 메시지는 ON DELETE CASCADE 로 같이 지워진다(0051).
  const r = await getPool().query(
    `DELETE FROM chat_thread WHERE id = $1 AND user_id = $2`,
    [threadId, user.id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function setSummary(threadId: string, summary: string): Promise<void> {
  await getPool().query(
    `UPDATE chat_thread SET summary = $2, updated_at = $3 WHERE id = $1`,
    [threadId, summary, Date.now()],
  );
}

// ── 메시지 ───────────────────────────────────────────────────────────────────────

export async function appendMessage(
  user: Actor,
  threadId: string,
  msg: { role: "user" | "assistant"; content: string; links?: AnswerLink[]; usedDocs?: string[] },
): Promise<void> {
  const now = Date.now();
  await getPool().query(
    `INSERT INTO chat_message (id, thread_id, user_id, role, content, links, used_docs, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [newId("sm"), threadId, user.id, msg.role, msg.content,
     JSON.stringify(msg.links ?? []), JSON.stringify(msg.usedDocs ?? []), now],
  );
  await getPool().query(
    `UPDATE chat_thread SET last_message_at = $2, updated_at = $2 WHERE id = $1`,
    [threadId, now],
  );
}

/** 오래된 것부터. 화면이 그대로 그린다. */
export async function listMessages(threadId: string, limit = MAX_THREAD_MESSAGES): Promise<MessageRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, role, content, links, used_docs AS "usedDocs", created_at AS "createdAt"
       FROM chat_message WHERE thread_id = $1
      ORDER BY created_at ASC LIMIT $2`,
    [threadId, limit],
  );
  return rows.map(normalizeMessage);
}

/**
 * 프롬프트에 실을 최근 대화. **최신 N개를 읽어 뒤집는다** — 오래된 것부터 읽어 자르면
 * 긴 스레드에서 엉뚱한 앞부분이 실린다(그 부분은 이미 요약에 들어가 있다).
 */
export async function recentMessages(threadId: string, n = CONTEXT_MESSAGES): Promise<MessageRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, role, content, links, used_docs AS "usedDocs", created_at AS "createdAt"
       FROM chat_message WHERE thread_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [threadId, n],
  );
  return rows.map(normalizeMessage).reverse();
}

export async function countMessages(threadId: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM chat_message WHERE thread_id = $1`, [threadId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * 이 사용자가 최근에 몇 번 물었나 — 남용 방어의 입력.
 * 사람이 창을 열어 두고 새로고침을 반복해도 원가가 선형으로 늘지 않게 한다.
 */
export async function countUserMessagesSince(user: Actor, since: number): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM chat_message
      WHERE user_id = $1 AND role = 'user' AND created_at > $2`,
    [user.id, since],
  );
  return rows[0]?.n ?? 0;
}

// ── 행 정규화 ────────────────────────────────────────────────────────────────────
// BIGINT 는 pg 가 문자열로 준다(정밀도 보존). 그대로 두면 화면에서 문자열 비교가 된다.

function normalizeThread(r: any): ThreadRow {
  return {
    id: r.id, title: r.title ?? "", summary: r.summary ?? null,
    createdAt: Number(r.createdAt), lastMessageAt: Number(r.lastMessageAt),
    ...(r.messageCount != null ? { messageCount: Number(r.messageCount) } : {}),
  };
}

function normalizeMessage(r: any): MessageRow {
  return {
    id: r.id,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content ?? "",
    links: Array.isArray(r.links) ? r.links : [],
    usedDocs: Array.isArray(r.usedDocs) ? r.usedDocs : [],
    createdAt: Number(r.createdAt),
  };
}

