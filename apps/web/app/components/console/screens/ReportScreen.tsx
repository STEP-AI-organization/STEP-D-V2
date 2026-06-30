"use client";

import { useRef, useState } from "react";
import { reportChat, type ReportChatMessage } from "@/lib/api";
import { C, card, ghostBtn, primaryBtn } from "@/lib/console/theme";
import { fmtWon } from "@/lib/console/format";
import {
  CONTENT_REV_MONTH,
  CUMULATIVE_REV,
  DEMO_CHAT_MESSAGES,
  DEMO_REPLY_MAP,
  DUMMY_CHANNELS,
  DUMMY_SCHED,
  PRODUCTS,
  PROGRAMS,
  REV_CHANNELS,
  REPORT_CHAT_RESPONSE,
} from "@/lib/console/dummy";
import { useConsole } from "../ConsoleProvider";

/* ── markdown → HTML ── */
function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, '<code style="background:#F1F2F4;padding:1px 5px;border-radius:4px;font-size:12px;">$1</code>');
  const lines = (src || "").split("\n");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^#{1,3}\s+/.test(line)) {
      closeList();
      const t = line.replace(/^#{1,3}\s+/, "");
      const fs = /^#\s/.test(line) ? "16px" : /^##\s/.test(line) ? "14.5px" : "13.5px";
      html += `<div style="font-size:${fs};font-weight:750;margin:11px 0 5px;letter-spacing:-.2px;">${inline(t)}</div>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul style="margin:4px 0;padding-left:18px;">'; inList = true; }
      html += `<li style="margin:3px 0;">${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
    } else if (line.trim() === "") {
      closeList(); html += '<div style="height:8px;"></div>';
    } else {
      closeList(); html += `<div style="margin:2px 0;">${inline(line)}</div>`;
    }
  }
  closeList();
  return html;
}

/* ── HTML 보고서 생성 ── */
function buildReportHtml(): string {
  const schedJuly = DUMMY_SCHED.filter((s) => s.month === 6 && s.status === "예약").slice(0, 12);

  const channelRows = DUMMY_CHANNELS.map(
    (ch) =>
      `<tr><td><strong>${ch.name}</strong></td><td>${ch.platform}</td><td>${ch.subs}</td>` +
      `<td>+${ch.d30subsPct}%</td><td>${ch.estMonthly}</td>` +
      `<td><span class="badge badge-${ch.grade.startsWith("A") ? "green" : "blue"}">${ch.grade}</span></td></tr>`
  ).join("");

  const programRows = PROGRAMS.map(
    (p) =>
      `<tr><td><strong>${p.name}</strong></td><td>${p.sub}</td><td>${p.clips}</td>` +
      `<td>${p.views}</td><td>${fmtWon(p.revenueN)}</td>` +
      `<td><span class="badge badge-${p.status === "배포완료" ? "green" : p.status === "배포중" ? "purple" : "gray"}">${p.status}</span></td></tr>`
  ).join("");

  const productRows = PRODUCTS.map(
    (p) =>
      `<tr><td><strong>${p.brand}</strong></td><td>${p.product}</td><td>${p.prog}</td>` +
      `<td>${p.plat}</td><td>${p.clicks}</td><td>${p.rate}</td><td><strong>${fmtWon(p.revN)}</strong></td></tr>`
  ).join("");

  const schedItems = schedJuly
    .map(
      (s) =>
        `<div class="sched-item"><div class="sched-date">7/${s.day} ${s.time}</div>` +
        `<div class="sched-title">${s.title}</div></div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>STEP D | PPL 광고주 제안 보고서 2026년 6월</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif;color:#0A0A14;background:#F7F7FB;line-height:1.6}
.container{max-width:920px;margin:0 auto;padding:48px 40px 80px;background:#fff;min-height:100vh}
.cover{background:#0A0A14;color:#fff;border-radius:16px;padding:64px 56px 52px;margin-bottom:52px;position:relative;overflow:hidden}
.cover::after{content:"";position:absolute;right:-60px;top:-60px;width:380px;height:380px;background:radial-gradient(circle,rgba(124,58,237,.35) 0%,transparent 70%);border-radius:50%}
.cover-badge{font-size:11px;letter-spacing:2px;color:#A78BFA;text-transform:uppercase;font-weight:800;margin-bottom:20px}
.cover h1{font-size:42px;font-weight:800;letter-spacing:-1.5px;line-height:1.15;margin-bottom:18px;position:relative;z-index:1}
.cover-meta{font-size:14px;color:rgba(255,255,255,.5)}
.cover-stats{display:flex;gap:36px;margin-top:40px;padding-top:28px;border-top:1px solid rgba(255,255,255,.12)}
.sv{font-size:30px;font-weight:800;letter-spacing:-.5px}
.sl{font-size:11px;color:rgba(255,255,255,.4);margin-top:3px}
.section{margin-bottom:52px}
.section-title{font-size:18px;font-weight:750;letter-spacing:-.3px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.section-title::before{content:"";display:inline-block;width:4px;height:20px;background:#7C3AED;border-radius:2px;flex-shrink:0}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.kpi-card{background:#F7F7FB;border-radius:12px;padding:20px}
.kpi-label{font-size:11.5px;color:#666;font-weight:600;margin-bottom:8px}
.kpi-value{font-size:24px;font-weight:800;letter-spacing:-.5px}
.kpi-caption{font-size:11px;color:#999;margin-top:5px}
.table-wrap{overflow-x:auto;border-radius:12px;border:1px solid #EAECF0}
table{width:100%;border-collapse:collapse;min-width:520px}
th{background:#F7F7FB;text-align:left;padding:11px 14px;font-size:11.5px;font-weight:700;color:#555;border-bottom:1px solid #EAECF0;white-space:nowrap}
td{padding:13px 14px;font-size:12.5px;border-bottom:1px solid #F5F5FA;vertical-align:middle}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700}
.badge-green{background:#ECFDF5;color:#059669}
.badge-blue{background:#EFF6FF;color:#2563EB}
.badge-purple{background:#F5F3FF;color:#7C3AED}
.badge-gray{background:#F3F4F6;color:#6B7280}
.pkg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.pkg-card{border:1.5px solid #E5E7EB;border-radius:14px;padding:24px;position:relative}
.pkg-card.best{border-color:#7C3AED;box-shadow:0 0 0 1px #7C3AED}
.pkg-best-badge{position:absolute;top:-1px;right:16px;background:#7C3AED;color:#fff;font-size:10px;font-weight:800;padding:3px 9px;border-radius:0 0 6px 6px;letter-spacing:.5px}
.pkg-name{font-size:15px;font-weight:750;margin-bottom:4px}
.pkg-price{font-size:28px;font-weight:800;letter-spacing:-.5px;color:#7C3AED;margin:12px 0 16px}
.pkg-price-sub{font-size:13px;font-weight:500;color:#AAA}
.pkg-feat{font-size:12.5px;color:#555;margin:5px 0;display:flex;gap:7px;align-items:flex-start}
.pkg-feat::before{content:"✓";color:#7C3AED;font-weight:800;flex-shrink:0}
.sched-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.sched-item{display:flex;gap:10px;padding:10px 14px;background:#F7F7FB;border-radius:8px;align-items:flex-start}
.sched-date{font-size:11px;font-weight:700;color:#7C3AED;min-width:52px;padding-top:1px;white-space:nowrap}
.sched-title{font-size:12px;color:#333;line-height:1.4}
.footer{margin-top:64px;padding-top:24px;border-top:1px solid #E5E7EB;font-size:11px;color:#BBB;text-align:center;line-height:1.9}
@media print{body{background:#fff}.container{padding:20px;box-shadow:none}.cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="container">

<div class="cover">
  <div class="cover-badge">STEP D · AI SHORTS PLATFORM</div>
  <h1>PPL 광고주<br>제안 보고서</h1>
  <div class="cover-meta">KT ENA · 2026년 6월 기준 · 생성일: 2026.06.29</div>
  <div class="cover-stats">
    <div><div class="sv">1,863</div><div class="sl">발행 클립</div></div>
    <div><div class="sv">1,240만</div><div class="sl">총 조회수</div></div>
    <div><div class="sv">₩3,840만</div><div class="sl">누적 수익 (추정)</div></div>
    <div><div class="sv">8개</div><div class="sl">활성 프로그램</div></div>
  </div>
</div>

<div class="section">
  <div class="section-title">Executive Summary</div>
  <div class="kpi-grid">
    <div class="kpi-card"><div class="kpi-label">이번 달 콘텐츠 수익</div><div class="kpi-value">${fmtWon(CONTENT_REV_MONTH)}</div><div class="kpi-caption">전월 대비 +32%</div></div>
    <div class="kpi-card"><div class="kpi-label">이번 달 커머스 수익</div><div class="kpi-value">${fmtWon(PRODUCTS.reduce((a, p) => a + p.revN, 0))}</div><div class="kpi-caption">${PRODUCTS.length}개 브랜드 연동</div></div>
    <div class="kpi-card"><div class="kpi-label">7월 예약 발행</div><div class="kpi-value">35건</div><div class="kpi-caption">7.1~7.21 순차 발행</div></div>
    <div class="kpi-card"><div class="kpi-label">평균 클립 완주율</div><div class="kpi-value">72%</div><div class="kpi-caption">업계 평균 대비 +28%</div></div>
  </div>
</div>

<div class="section">
  <div class="section-title">수익 채널 구성</div>
  <div class="table-wrap"><table>
    <thead><tr><th>플랫폼</th><th>비중</th><th>RPM</th><th>수익 배분</th></tr></thead>
    <tbody>${REV_CHANNELS.map((r) => `<tr><td><strong>${r.name}</strong></td><td>${r.pct}%</td><td>${r.rpm}</td><td>${r.share}</td></tr>`).join("")}</tbody>
  </table></div>
</div>

<div class="section">
  <div class="section-title">채널 성과 현황</div>
  <div class="table-wrap"><table>
    <thead><tr><th>채널명</th><th>플랫폼</th><th>구독자</th><th>30일 성장률</th><th>추정 월수익</th><th>등급</th></tr></thead>
    <tbody>${channelRows}</tbody>
  </table></div>
</div>

<div class="section">
  <div class="section-title">프로그램별 PPL 노출 현황</div>
  <div class="table-wrap"><table>
    <thead><tr><th>프로그램</th><th>분류</th><th>발행 클립</th><th>총 조회수</th><th>추정 수익</th><th>상태</th></tr></thead>
    <tbody>${programRows}</tbody>
  </table></div>
</div>

<div class="section">
  <div class="section-title">커머스 연동 성과</div>
  <div class="table-wrap"><table>
    <thead><tr><th>브랜드</th><th>상품</th><th>노출 프로그램</th><th>플랫폼</th><th>클릭수</th><th>수수료율</th><th>추정 수익</th></tr></thead>
    <tbody>${productRows}</tbody>
  </table></div>
</div>

<div class="section">
  <div class="section-title">PPL 패키지 제안</div>
  <div class="pkg-grid">
    <div class="pkg-card">
      <div class="pkg-name">Starter</div>
      <div class="pkg-price">₩500만 <span class="pkg-price-sub">/ 월</span></div>
      <div class="pkg-feat">프로그램 1개 PPL 노출</div>
      <div class="pkg-feat">쇼츠 클립 8개 자동 제작</div>
      <div class="pkg-feat">월간 성과 리포트</div>
      <div class="pkg-feat">커머스 링크 1건</div>
    </div>
    <div class="pkg-card best">
      <div class="pkg-best-badge">BEST</div>
      <div class="pkg-name">Standard</div>
      <div class="pkg-price">₩1,200만 <span class="pkg-price-sub">/ 월</span></div>
      <div class="pkg-feat">프로그램 3개 PPL 노출</div>
      <div class="pkg-feat">쇼츠 클립 24개 자동 제작</div>
      <div class="pkg-feat">주간 성과 리포트 + AI 인사이트</div>
      <div class="pkg-feat">커머스 링크 3건</div>
      <div class="pkg-feat">자동 배포 스케줄링</div>
    </div>
    <div class="pkg-card">
      <div class="pkg-name">Premium</div>
      <div class="pkg-price">₩3,000만 <span class="pkg-price-sub">/ 월</span></div>
      <div class="pkg-feat">전 프로그램 PPL 노출</div>
      <div class="pkg-feat">쇼츠 클립 무제한 제작</div>
      <div class="pkg-feat">실시간 대시보드 접근권</div>
      <div class="pkg-feat">커머스 링크 무제한</div>
      <div class="pkg-feat">전담 CSM 배정</div>
      <div class="pkg-feat">광고주 전용 분석 API</div>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">7월 배포 스케줄 (예약 35건)</div>
  <div class="sched-grid">${schedItems}</div>
</div>

<div class="footer">
  <div><strong>STEP D</strong> — AI 기반 쇼츠 자동 생성 플랫폼 · stepai.kr</div>
  <div>본 보고서의 수익 수치는 추정값입니다. 중요한 계약 전 원본 데이터를 확인하세요.</div>
  <div style="margin-top:6px;color:#CCC">생성일: 2026년 6월 29일 · powered by STEP D AI</div>
</div>

</div>
</body>
</html>`;
}

function downloadReport() {
  const html = buildReportHtml();
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "STEPD_PPL보고서_2026년6월.html";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const REPORT_KEYWORDS = ["보고서", "리포트", "report", "초안", "다운로드", "내보내기", "파일"];

const SUGGESTIONS = [
  "이번 달 수익을 한 문단으로 요약해줘",
  "구독자 성장률이 가장 높은 채널은?",
  "PPL 광고주 현황 분석해줘",
  "7월 배포 스케줄 어떻게 돼?",
  "보고서 만들어줘",
];

export function ReportScreen() {
  const c = useConsole();
  const [messages, setMessages] = useState<ReportChatMessage[]>(
    DEMO_CHAT_MESSAGES as ReportChatMessage[]
  );
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const context = {
    요약: {
      이번달콘텐츠수익_추정: fmtWon(CONTENT_REV_MONTH),
      이번달커머스수익_추정: fmtWon(PRODUCTS.reduce((a, p) => a + p.revN, 0)),
      누적수익_추정: fmtWon(CUMULATIVE_REV),
      연결채널수: c.channels.length || DUMMY_CHANNELS.length,
      프로젝트수: c.projects.length,
    },
    수익채널비중: REV_CHANNELS.map((r) => ({ 채널: r.name, 비중: r.pct + "%", RPM: r.rpm })),
    프로그램: PROGRAMS.map((p) => ({ 이름: p.name, 클립: p.clips, 조회수: p.views, 수익: fmtWon(p.revenueN), 상태: p.status })),
    커머스: PRODUCTS.map((p) => ({ 브랜드: p.brand, 플랫폼: p.plat, 수수료: p.rate, 수익: fmtWon(p.revN) })),
  };

  const scrollDown = () => requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    const userMsg: ReportChatMessage = { role: "user", content: q };
    setMessages((m) => [...m, userMsg]);
    setInputText("");
    setLoading(true);
    scrollDown();

    // 보고서 요청 감지
    if (REPORT_KEYWORDS.some((k) => q.includes(k))) {
      downloadReport();
      setMessages((m) => [...m, { role: "assistant", content: REPORT_CHAT_RESPONSE }]);
      setLoading(false);
      scrollDown();
      return;
    }

    // 즉시 응답 매핑
    const matched = DEMO_REPLY_MAP.find(([keywords]) => keywords.some((k) => q.includes(k)));
    if (matched) {
      setMessages((m) => [...m, { role: "assistant", content: matched[1] }]);
      setLoading(false);
      scrollDown();
      return;
    }

    // 실제 API 호출 (fallback)
    try {
      const next = [...messages, userMsg];
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

      {/* 채팅 영역 */}
      <div ref={scrollRef} style={{ flex: "1 1 auto", overflowY: "auto", padding: "26px 0 12px" }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 18 }}>
            {m.role === "assistant" && (
              <div style={{ width: 28, height: 28, borderRadius: 8, background: C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0, marginRight: 10, marginTop: 2 }}>D</div>
            )}
            <div style={{ maxWidth: m.role === "user" ? "76%" : "calc(100% - 38px)", background: m.role === "user" ? C.ink : "#fff", color: m.role === "user" ? "#fff" : C.ink, border: m.role === "user" ? "none" : `1px solid ${C.line}`, borderRadius: 14, padding: "13px 16px", fontSize: 13.5, lineHeight: 1.65, letterSpacing: "-.1px" }}>
              {m.role === "user"
                ? <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                : <div dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>D</div>
            <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px", fontSize: 13, color: C.muted }}>분석 중…</div>
          </div>
        )}
      </div>

      {/* 빠른 질문 + 보고서 버튼 */}
      <div style={{ flex: "0 0 auto", borderTop: `1px solid ${C.lineSoft}`, paddingTop: 14, paddingBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {SUGGESTIONS.map((s) => {
            const isReport = s.includes("보고서");
            return (
              <button
                key={s}
                onClick={() => void send(s)}
                className="hv-card"
                style={{
                  background: isReport ? C.violet : "#fff",
                  color: isReport ? "#fff" : C.sub,
                  border: isReport ? "none" : `1px solid ${C.line}`,
                  borderRadius: 20,
                  padding: "7px 14px",
                  fontSize: 12,
                  cursor: "pointer",
                  letterSpacing: "-.2px",
                  fontWeight: isReport ? 700 : 500,
                }}
              >
                {isReport ? "⬇ " : ""}{s}
              </button>
            );
          })}
          <button
            onClick={() => setMessages([])}
            style={{ marginLeft: "auto", ...ghostBtn, padding: "6px 12px", fontSize: 11.5, borderRadius: 20 }}
          >
            대화 초기화
          </button>
        </div>

        {/* 입력창 */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: "10px 10px 10px 16px", boxShadow: "0 2px 10px rgba(16,18,24,.04)" }}>
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(inputText); } }}
            placeholder="STEP D 데이터에 대해 무엇이든 물어보세요…"
            rows={1}
            style={{ flex: 1, border: "none", outline: "none", resize: "none", fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.5, color: C.ink, background: "transparent", maxHeight: 140, padding: "7px 0" }}
          />
          <button
            onClick={() => void send(inputText)}
            disabled={!inputText.trim() || loading}
            style={{ flex: "0 0 auto", width: 38, height: 38, border: "none", borderRadius: 10, background: inputText.trim() && !loading ? C.violet : "#D5D9DF", color: "#fff", cursor: inputText.trim() && !loading ? "pointer" : "default", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}
          >↑</button>
        </div>
        <div style={{ fontSize: 10.5, color: C.faint, textAlign: "center", marginTop: 9 }}>수익·추정 수치는 가정값 기반입니다. 중요한 의사결정 전 원본 데이터를 확인하세요.</div>
      </div>
    </div>
  );
}
