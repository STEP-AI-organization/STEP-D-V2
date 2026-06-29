"use client";

import { useMemo, useRef, useState } from "react";
import { reportChat, type ReportChatMessage } from "@/lib/api";
import { C } from "@/lib/console/theme";
import { fmtWon } from "@/lib/console/format";
import { CONTENT_REV_MONTH, CUMULATIVE_REV, DUMMY_CHANNELS, PRODUCTS, PROGRAMS, REV_CHANNELS } from "@/lib/console/dummy";
import { useConsole } from "../ConsoleProvider";

/* Minimal markdown → HTML for assistant replies (headings/bold/lists/code). */
function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, '<code style="background:#F1F2F4;padding:1px 5px;border-radius:4px;font-size:12px;">$1</code>');
  const lines = (src || "").split("\n");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^#{1,3}\s+/.test(line)) {
      closeList();
      const t = line.replace(/^#{1,3}\s+/, "");
      const fs = /^#\s/.test(line) ? "16px" : /^##\s/.test(line) ? "14.5px" : "13.5px";
      html += `<div style="font-size:${fs};font-weight:750;margin:11px 0 5px;letter-spacing:-.2px;">${inline(t)}</div>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        html += '<ul style="margin:4px 0;padding-left:18px;">';
        inList = true;
      }
      html += `<li style="margin:3px 0;">${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
    } else if (line.trim() === "") {
      closeList();
      html += '<div style="height:8px;"></div>';
    } else {
      closeList();
      html += `<div style="margin:2px 0;">${inline(line)}</div>`;
    }
  }
  closeList();
  return html;
}

const SUGGESTIONS = [
  "이번 달 수익을 한 문단으로 요약해줘",
  "구독자 성장률이 가장 높은 채널은?",
  "PPL 광고주 제안용 보고서 초안을 작성해줘",
  "쯔양먹방 5회 수익이 어디서 나왔는지 알려줘",
];

export function ReportScreen() {
  const c = useConsole();
  const [messages, setMessages] = useState<ReportChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Data context: real where available, dummy estimates otherwise.
  const context = useMemo(() => {
    const channelData = c.channels.length
      ? c.channels.map((ch) => ({ 이름: ch.name, 구독자: ch.subs, 총조회수: ch.views, 기본채널: ch.isDefault }))
      : DUMMY_CHANNELS.map((d) => ({ 이름: d.name, 플랫폼: d.platform, 구독자: d.subs, 총조회수: d.views, 성장등급_추정: d.grade, "최근30일구독_추정": d.d30subsN, 예상월수익_추정: d.estMonthly }));
    return {
      요약: {
        이번달콘텐츠수익_추정: fmtWon(CONTENT_REV_MONTH),
        이번달커머스수익_추정: fmtWon(PRODUCTS.reduce((a, p) => a + p.revN, 0)),
        누적수익_추정: fmtWon(CUMULATIVE_REV),
        연결채널수: c.channels.length || DUMMY_CHANNELS.length,
        프로젝트수: c.projects.length,
        발행대기클립: c.pickerClips.length,
        예약발행: c.sched.filter((s) => s.status === "예약").length,
      },
      수익채널비중: REV_CHANNELS.map((r) => ({ 채널: r.name, 비중: r.pct + "%", RPM: r.rpm })),
      채널: channelData,
      프로그램: PROGRAMS.map((p) => ({ 이름: p.name, 회차: p.sub, 발행클립: p.clips, 조회수: p.views, 회차수익_추정: fmtWon(p.revenueN), 상태: p.status })),
      커머스연결: PRODUCTS.map((p) => ({ 브랜드: p.brand, 상품: p.product, 노출프로그램: p.prog, 플랫폼: p.plat, 수수료: p.rate, 예상수익_추정: fmtWon(p.revN) })),
    };
  }, [c.channels, c.projects, c.pickerClips, c.sched]);

  const scrollDown = () => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    const next = [...messages, { role: "user" as const, content: q }];
    setMessages(next);
    setInputText("");
    setLoading(true);
    scrollDown();
    try {
      const res = await reportChat({ messages: next, context });
      setMessages((m) => [...m, { role: "assistant", content: res.answer || "답변을 가져오지 못했어요." }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "오류가 발생했어요. 잠시 후 다시 시도해 주세요." }]);
    } finally {
      setLoading(false);
      scrollDown();
    }
  };

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 28px", height: "100%", display: "flex", flexDirection: "column" }}>
      <div ref={scrollRef} style={{ flex: "1 1 auto", overflowY: "auto", padding: "26px 0 16px" }}>
        {messages.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "48px 0 30px" }}>
            <div style={{ width: 48, height: 48, borderRadius: 13, background: C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 800, letterSpacing: "-.5px" }}>D</div>
            <div style={{ fontSize: 20, fontWeight: 750, letterSpacing: "-.4px", marginTop: 18 }}>무엇이 궁금하세요?</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 1.6, maxWidth: 480 }}>채널·프로그램·수익·커머스 데이터를 모두 알고 있어요. 질문하면 답하고, 보고서도 작성해 드려요.</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 9, justifyContent: "center", marginTop: 24, maxWidth: 640 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="hv-card" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 14px", fontSize: 12.5, color: C.sub, cursor: "pointer", textAlign: "left", letterSpacing: "-.2px" }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 18 }}>
            <div style={{ maxWidth: m.role === "user" ? "78%" : "100%", background: m.role === "user" ? C.ink : "#fff", color: m.role === "user" ? "#fff" : C.ink, border: m.role === "user" ? "none" : `1px solid ${C.line}`, borderRadius: 14, padding: "13px 16px", fontSize: 13.5, lineHeight: 1.65, letterSpacing: "-.1px" }}>
              {m.role === "user" ? <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div> : <div dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 18 }}>
            <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px", fontSize: 13, color: C.muted }}>생성 중…</div>
          </div>
        )}
      </div>

      <div style={{ flex: "0 0 auto", padding: "6px 0 22px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: "10px 10px 10px 16px", boxShadow: "0 2px 10px rgba(16,18,24,.04)" }}>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(inputText);
              }
            }}
            placeholder="STEP D 데이터에 대해 무엇이든 물어보세요…"
            rows={1}
            style={{ flex: 1, border: "none", outline: "none", resize: "none", fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.5, color: C.ink, background: "transparent", maxHeight: 140, padding: "7px 0" }}
          />
          <button onClick={() => void send(inputText)} disabled={!inputText.trim() || loading} style={{ flex: "0 0 auto", width: 38, height: 38, border: "none", borderRadius: 10, background: inputText.trim() && !loading ? C.violet : "#D5D9DF", color: "#fff", cursor: inputText.trim() && !loading ? "pointer" : "default", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>↑</button>
        </div>
        <div style={{ fontSize: 10.5, color: C.faint, textAlign: "center", marginTop: 9 }}>수익·추정 수치는 가정값 기반입니다. 중요한 의사결정 전 원본 데이터를 확인하세요.</div>
      </div>
    </div>
  );
}
