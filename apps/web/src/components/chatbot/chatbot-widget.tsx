"use client";

/**
 * 업무 도우미 챗봇 위젯 — 전 화면 우하단.
 *
 * 설계는 `docs/prototypes/chatbot-widget-mockup.html` 의 실측판 그대로다(폭 380 · 트리거 52 ·
 * 말풍선 12px · 링크는 칩). 색·서체는 제품 토큰(`--sd-*`)만 쓴다 — 챗봇 전용 색을 새로
 * 만들면 제품 안에서 이질적인 표면이 하나 더 생긴다.
 *
 * ## 이 컴포넌트가 지키는 것
 *
 *  - **링크는 서버가 준 것만 그린다.** 본문 텍스트에서 경로를 찾아 링크로 만들지 않는다 —
 *    화이트리스트 판정은 서버(`chatbot/catalog.ts`)가 이미 했고, 여기서 또 하면 두 벌이 된다.
 *  - **보고서는 링크가 아니라 내용으로 받는다.** 아직 리포트 화면이 없어서, 없는 경로를
 *    링크로 주면 그게 곧 거짓말이 된다.
 *  - **실패를 삼키지 않는다.** 서버가 사람 말로 준 사유(한도 초과 등)를 그대로 보여준다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Loader2, MessageCircle, Plus, X } from "lucide-react";

import {
  API_BASE, deleteChatbotThread, fetchChatbotThread, fetchChatbotThreads, sendChatbotMessage,
  type ChatLink, type ChatMessage, type ChatReport, type ChatThreadSummary,
} from "@/lib/data/api";

interface Bubble {
  role: "user" | "assistant";
  text: string;
  links?: ChatLink[];
  usedDocs?: string[];
  report?: ChatReport;
}

const GREETING: Bubble = {
  role: "assistant",
  text: "무엇을 도와드릴까요? 화면 사용법이나 지금 워크스페이스 상태를 물어보시면 됩니다.",
};

export function ChatbotWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "threads">("chat");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([GREETING]);
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 새 말풍선이 생기면 항상 아래로. 답이 길면 위쪽만 보이고 끝을 못 본다.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [bubbles, busy]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setError(null);
    setBubbles((b) => [...b, { role: "user", text: message }]);
    setBusy(true);
    try {
      const out = await sendChatbotMessage({ message, threadId, screen: pathname });
      setThreadId(out.threadId);
      setBubbles((b) => [...b, {
        role: "assistant", text: out.reply, links: out.links,
        usedDocs: out.usedDocs, report: out.report,
      }]);
    } catch (e) {
      // 서버가 준 사유를 그대로 — "요청이 너무 많습니다" 같은 문장이 여기서 사라지면
      // 사용자는 무엇을 기다려야 하는지 모른다.
      setError(e instanceof Error ? e.message : "답변을 받지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [draft, busy, threadId, pathname]);

  const openThreads = useCallback(async () => {
    setView("threads");
    setError(null);
    try {
      setThreads(await fetchChatbotThreads());
    } catch (e) {
      setError(e instanceof Error ? e.message : "대화 목록을 불러오지 못했습니다.");
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setError(null);
    try {
      const { thread, messages } = await fetchChatbotThread(id);
      setThreadId(thread.id);
      setBubbles(messages.length
        ? messages.map((m: ChatMessage) => ({
            role: m.role, text: m.content, links: m.links, usedDocs: m.usedDocs,
          }))
        : [GREETING]);
      setView("chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : "대화를 불러오지 못했습니다.");
    }
  }, []);

  const startNew = useCallback(() => {
    setThreadId(null);
    setBubbles([GREETING]);
    setView("chat");
    setError(null);
  }, []);

  if (!open) {
    return (
      <button
        type="button"
        aria-label="도우미 열기"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 grid h-[52px] w-[52px] place-items-center rounded-full transition-transform hover:scale-105"
        style={{ background: "var(--sd-accent)", color: "var(--sd-on-accent)", boxShadow: "0 6px 20px rgba(31,79,216,.35)" }}
      >
        <MessageCircle size={22} />
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-6 right-6 z-40 flex w-[380px] flex-col overflow-hidden rounded-[14px]"
      style={{
        height: "min(620px, 78vh)",
        background: "var(--sd-card)",
        border: "1px solid var(--sd-border)",
        boxShadow: "0 8px 28px rgba(31,30,28,.14)",
      }}
    >
      {/* 헤더 */}
      <div
        className="flex items-center gap-2 px-3.5 py-3"
        style={{ borderBottom: "1px solid var(--sd-divider)", background: "var(--sd-card-sub)" }}
      >
        <div className="sd-serif flex-1 text-[14.5px] font-bold" style={{ color: "var(--sd-fg)" }}>
          {view === "threads" ? "대화" : "도우미"}
        </div>
        <IconButton label="새 대화" onClick={startNew}><Plus size={15} /></IconButton>
        <IconButton
          label={view === "threads" ? "대화로 돌아가기" : "지난 대화"}
          onClick={() => (view === "threads" ? setView("chat") : openThreads())}
        >
          <span className="text-[13px] leading-none">☰</span>
        </IconButton>
        <IconButton label="닫기" onClick={() => setOpen(false)}><X size={15} /></IconButton>
      </div>

      {/* 본문 */}
      <div ref={bodyRef} className="flex-1 overflow-auto px-3.5 py-3.5">
        {view === "threads" ? (
          <ThreadList threads={threads} onOpen={loadThread} onDelete={async (id) => {
            await deleteChatbotThread(id).catch(() => {});
            setThreads((t) => t.filter((x) => x.id !== id));
            if (id === threadId) startNew();
          }} />
        ) : (
          <div className="flex flex-col gap-3.5">
            {bubbles.map((b, i) => <BubbleView key={i} bubble={b} onNavigate={() => setOpen(false)} />)}
            {busy && (
              <div className="flex items-center gap-2 self-start text-[12px]" style={{ color: "var(--sd-mut)" }}>
                <Loader2 size={13} className="animate-spin" /> 답을 만들고 있습니다…
              </div>
            )}
          </div>
        )}
      </div>

      {/* 오류 — 서버가 준 사유 그대로 */}
      {error && (
        <div
          className="px-3.5 py-2 text-[12px]"
          style={{ background: "var(--sd-danger-bg)", color: "var(--sd-danger)", borderTop: "1px solid var(--sd-danger-border)" }}
        >
          {error}
        </div>
      )}

      {/* 입력 */}
      <div className="px-3 py-2.5" style={{ borderTop: "1px solid var(--sd-divider)" }}>
        {view === "chat" && pathname && (
          <span
            className="sd-mono mb-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px]"
            style={{ border: "1px solid var(--sd-border)", color: "var(--sd-mut)" }}
          >
            보는 중 · {pathname}
          </span>
        )}
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            placeholder="무엇이든 물어보세요"
            className="flex-1 rounded-[10px] px-3 py-2 text-[13px] outline-none"
            style={{ border: "1px solid var(--sd-control-border)", background: "var(--sd-control)", color: "var(--sd-fg)" }}
          />
          <button
            type="button"
            aria-label="보내기"
            onClick={() => void send()}
            disabled={busy || !draft.trim()}
            className="grid h-9 w-9 flex-none place-items-center rounded-[10px] disabled:opacity-40"
            style={{ background: "var(--sd-accent)", color: "var(--sd-on-accent)" }}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

function IconButton({ label, onClick, children }: {
  label: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-[7px] transition-colors hover:brightness-95"
      style={{ color: "var(--sd-mut)", background: "transparent" }}
    >
      {children}
    </button>
  );
}

function BubbleView({ bubble, onNavigate }: { bubble: Bubble; onNavigate: () => void }) {
  if (bubble.role === "user") {
    return (
      <div
        className="max-w-[88%] self-end rounded-[12px_12px_4px_12px] px-3 py-2 text-[13px] leading-[1.65]"
        style={{ background: "var(--sd-accent-bg)", border: "1px solid var(--sd-accent-border)", color: "var(--sd-fg)" }}
      >
        {bubble.text}
      </div>
    );
  }
  return (
    <div
      className="max-w-[92%] self-start rounded-[12px_12px_12px_4px] px-3 py-2.5 text-[13px] leading-[1.65]"
      style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)", color: "var(--sd-fg)" }}
    >
      <div className="whitespace-pre-wrap">{stripLinkSyntax(bubble.text)}</div>

      {!!bubble.links?.length && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {bubble.links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={onNavigate}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors"
              style={{ border: "1px solid var(--sd-accent-border)", color: "var(--sd-accent)", background: "var(--sd-card)" }}
            >
              {l.label} <span aria-hidden style={{ opacity: 0.7 }}>→</span>
            </Link>
          ))}
        </div>
      )}

      {bubble.report && <ReportCard report={bubble.report} />}

      {!!bubble.usedDocs?.length && (
        <div className="sd-mono mt-2 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
          참고 · {bubble.usedDocs.join(" · ")}
        </div>
      )}
    </div>
  );
}

/**
 * 본문의 마크다운 링크 문법을 글자로 되돌린다 — `[자동 배포](/automation)` → `자동 배포`.
 * 링크는 아래 칩으로 따로 그리므로, 본문에 괄호 경로가 그대로 보이면 두 번 말하는 셈이다.
 * **판정이 아니라 표시**다: 무엇이 링크가 될 수 있는지는 서버가 이미 정했다.
 */
function stripLinkSyntax(text: string): string {
  return text.replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, "$1");
}

/**
 * 보고서 카드 — **핵심 수치만** 그린다.
 *
 * 처음엔 마크다운 본문을 그대로 펼쳐 보여줬는데, 위젯 폭이 380px 라 파이프 표와 `<sub>`
 * 태그가 그대로 보였다(실측 2026-09-03). 표는 이 폭에서 절대 안 읽힌다 — 그래서 여기서는
 * 숫자 몇 줄만 보여 주고, 전문은 HTML 내보내기로 넘긴다.
 */
function ReportCard({ report }: { report: ChatReport }) {
  const blocked = report.warnings.some((w) => w.includes("검산"));
  return (
    <div className="mt-2.5 overflow-hidden rounded-[10px]" style={{ border: "1px solid var(--sd-border)" }}>
      <div
        className="px-3 py-2"
        style={{ background: "var(--sd-card-sub)", borderBottom: "1px solid var(--sd-divider)" }}
      >
        <div className="text-[12.5px] font-bold" style={{ color: "var(--sd-fg)" }}>{report.title}</div>
        <div className="sd-mono mt-0.5 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{report.period}</div>
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        {report.headline.map((m) => (
          <div key={m.label} className="flex items-baseline justify-between gap-3">
            <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>{m.label}</span>
            <span className="sd-mono text-[13px] font-bold" style={{ color: "var(--sd-fg)" }}>
              {m.value.toLocaleString("ko-KR")}
              <span className="ml-0.5 text-[10.5px] font-normal" style={{ color: "var(--sd-mut)" }}>{m.unit}</span>
              {m.delta != null && (
                <span className="ml-1.5 text-[10.5px] font-normal" style={{ color: "var(--sd-mut)" }}>
                  {m.delta >= 0 ? "+" : ""}{m.delta.toLocaleString("ko-KR")}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="flex gap-1.5 px-3 py-2" style={{ borderTop: "1px solid var(--sd-divider)" }}>
        {/* 검산이 어긋나면 서버가 409 로 막는다. 여기서도 눌리지 않게 해서 헛클릭을 없앤다. */}
        <ExportLink id={report.id} format="html" disabled={blocked} primary />
        <ExportLink id={report.id} format="md" disabled={blocked} />
      </div>

      {!!report.warnings.length && (
        <div
          className="px-3 py-2 text-[11.5px]"
          style={{ background: "var(--sd-warn-bg)", color: "var(--sd-warn-fg)", borderTop: "1px solid var(--sd-warn-border)" }}
        >
          {report.warnings.join(" / ")}
        </div>
      )}
    </div>
  );
}

function ExportLink({ id, format, disabled, primary }: {
  id: string; format: "html" | "md"; disabled: boolean; primary?: boolean;
}) {
  const label = format === "html" ? "전문 열기 (HTML)" : "마크다운";
  const style = {
    border: `1px solid ${primary ? "var(--sd-accent)" : "var(--sd-control-border)"}`,
    background: primary ? "var(--sd-accent)" : "var(--sd-control)",
    color: primary ? "var(--sd-on-accent)" : "var(--sd-fg)",
    opacity: disabled ? 0.45 : 1,
  } as const;
  if (disabled) {
    return <span className="cursor-not-allowed rounded-[7px] px-2.5 py-1 text-[11.5px]" style={style}>{label}</span>;
  }
  return (
    <a
      href={`${API_BASE}/reports/${id}/export?format=${format}`}
      target="_blank"
      rel="noreferrer"
      className="rounded-[7px] px-2.5 py-1 text-[11.5px]"
      style={style}
    >
      {label}
    </a>
  );
}

function ThreadList({ threads, onOpen, onDelete }: {
  threads: ChatThreadSummary[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!threads.length) {
    return <div className="py-8 text-center text-[12px]" style={{ color: "var(--sd-mut)" }}>지난 대화가 없습니다.</div>;
  }
  return (
    <div className="flex flex-col">
      {threads.map((t) => (
        <div key={t.id} className="group flex items-center gap-2 rounded-[9px] px-2.5 py-2 hover:brightness-[.98]"
             style={{ background: "transparent" }}>
          <button type="button" onClick={() => onOpen(t.id)} className="flex-1 text-left">
            <div className="truncate text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>{t.title}</div>
            <div className="sd-mono mt-0.5 text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
              {new Date(t.lastMessageAt).toLocaleDateString("ko-KR")} · {t.messageCount ?? 0}개
            </div>
          </button>
          <button
            type="button"
            aria-label="대화 삭제"
            onClick={() => onDelete(t.id)}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            style={{ color: "var(--sd-mut)" }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
