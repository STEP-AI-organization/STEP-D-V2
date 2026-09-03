/**
 * 리포트 산출물 — 마크다운(정본)과 HTML(보여 주는 것).
 *
 * ## 왜 마크다운이 정본인가
 *
 * 저장·비교·수정이 되는 형태여야 한다. HTML 은 **같은 데이터에서 언제든 다시 그릴 수 있는
 * 파생물**이라 저장하지 않는다(저장하면 본문과 어긋난 사본이 생긴다).
 *
 * ## HTML 은 목업을 따른다
 *
 * `AENA_실적_개선목업_20260902.html` 의 구조 그대로 — 헤드라인 카드 → 표(합계 행 포함) →
 * 기준·출처 각주. 스타일은 전부 인라인이고 바깥 자산을 하나도 안 부른다(메일·오프라인·
 * 인쇄에서 같은 모양이 나와야 한다).
 *
 * ## 각주에 기준일을 반드시 적는다
 *
 * 유튜브 지표는 며칠 전 것일 수 있다. 목업이 "동기화 34일 전 기준" 을 머리에 달아 둔 이유가
 * 그것이다 — 언제 기준인지 모르는 숫자는 회의에서 **가장 비싼 오해**가 된다.
 */
import { KIND_LABEL, type ReportData } from "./aggregate.ts";

/** 천 단위 구분. 표의 숫자는 눈으로 자릿수를 세게 두지 않는다. */
function n(v: string | number): string {
  return typeof v === "number" ? v.toLocaleString("ko-KR") : String(v);
}

function deltaText(m: { delta?: number; unit: string }): string {
  if (m.delta == null) return "";
  const sign = m.delta > 0 ? "+" : "";
  return `${sign}${m.delta.toLocaleString("ko-KR")}${m.unit}`;
}

/** "3일 전 기준" — 없으면 조회 시점이라는 뜻이다. */
function freshness(asOf: string | null, now: Date): string {
  if (!asOf) return "조회 시점";
  const days = Math.floor((now.getTime() - Date.parse(asOf)) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(days)) return "기준 시각 불명";
  return days <= 0 ? "오늘 기준" : `${days}일 전 기준`;
}

export function crosscheckFailures(data: ReportData): string[] {
  return data.crosscheck.filter((c) => !c.ok)
    .map((c) => `${c.name}: 기대 ${c.expected} · 실제 ${c.actual}`);
}

// ── 마크다운 ─────────────────────────────────────────────────────────────────────

export function toMarkdown(data: ReportData, narration: string, now: Date = new Date()): string {
  const out: string[] = [];
  out.push(`# ${data.title}`, "");
  out.push(`**기간** ${data.period.from} ~ ${data.period.to}` +
    (data.period.compare ? `　**비교** ${data.period.compare.from} ~ ${data.period.compare.to}` : ""));
  out.push("");

  if (narration) out.push(narration, "");

  out.push("## 핵심 수치", "");
  out.push("| 항목 | 값 | 직전 기간 대비 |", "|---|---:|---:|");
  for (const m of data.headline) {
    out.push(`| ${m.label}${m.note ? ` <sub>${m.note}</sub>` : ""} | ${n(m.value)}${m.unit} | ${deltaText(m) || "—"} |`);
  }
  out.push("");

  for (const s of data.sections) {
    out.push(`## ${s.title}`, "");
    const align = s.columns.map((_, i) => (i === 0 ? "---" : "---:"));
    out.push(`| ${s.columns.join(" | ")} |`, `|${align.join("|")}|`);
    for (const row of s.rows) out.push(`| ${row.map(n).join(" | ")} |`);
    if (s.total) out.push(`| **${n(s.total[0])}** | ${s.total.slice(1).map((v) => `**${n(v)}**`).join(" | ")} |`);
    if (s.note) out.push("", `<sub>${s.note}</sub>`);
    out.push("");
  }

  out.push("---", "");
  out.push(`데이터 기준 — ${data.sources.map((s) => `${s.what}: ${freshness(s.asOf, now)}`).join(" · ")}`);
  const fails = crosscheckFailures(data);
  if (fails.length) out.push("", `> ⚠️ 검산 불일치: ${fails.join(" / ")}`);
  out.push("", `<sub>${KIND_LABEL[data.kind]} · 자동 생성 초안입니다. 판단·해석은 작성자가 채워 주세요.</sub>`);
  return out.join("\n");
}

// ── HTML ────────────────────────────────────────────────────────────────────────

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
  :root{--line:#e5e5e8;--ink:#1c1c1e;--sub:#8a8a8f;--blue:#3b6ef5}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#fff;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,
    "Apple SD Gothic Neo","Malgun Gothic",sans-serif;font-size:14px;padding:44px 40px;line-height:1.55}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:19px;font-weight:800}
  .meta{font-size:12.5px;color:#555;margin-top:8px}
  .lead{font-size:13.5px;color:#333;margin-top:18px;line-height:1.75}
  .panel{border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-top:22px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
  .kcard{border:1px solid var(--line);border-left:3px solid #d9d9de;border-radius:10px;padding:14px 16px}
  .kcard.hl{border-left-color:var(--blue)}
  .kcard .t{font-size:12px;color:#555}
  .kcard .v{font-size:26px;font-weight:800;margin-top:4px}
  .kcard .v small{font-size:13px;font-weight:500;color:var(--sub)}
  .kcard .d{font-size:11.5px;color:var(--sub);margin-top:3px}
  h2{font-size:14px;font-weight:700;margin-top:26px}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:12px}
  th{font-size:12px;color:var(--sub);font-weight:600;text-align:right;padding:10px 12px;
    border-bottom:1px solid var(--line)}
  th:first-child{text-align:left}
  td{padding:12px;border-bottom:1px solid #f0f0f2;text-align:right;font-variant-numeric:tabular-nums}
  td:first-child{text-align:left;font-weight:600}
  tr.total td{border-top:2px solid var(--ink);border-bottom:none;font-weight:700}
  .warn{margin-top:18px;background:#fff7e6;border:1px solid #f0c36d;border-radius:10px;
    padding:14px 18px;font-size:13px}
  .foot{margin-top:20px;color:var(--sub);font-size:12px}
  @media print{body{padding:0}.panel{break-inside:avoid}}
`;

export function toHtml(data: ReportData, narration: string, now: Date = new Date()): string {
  const cards = data.headline.map((m, i) => `
      <div class="kcard${i === 0 ? " hl" : ""}">
        <div class="t">${esc(m.label)}${m.note ? ` <small>(${esc(m.note)})</small>` : ""}</div>
        <div class="v">${esc(n(m.value))} <small>${esc(m.unit)}</small></div>
        ${m.delta != null ? `<div class="d">직전 기간 대비 ${esc(deltaText(m))}</div>` : ""}
      </div>`).join("");

  const tables = data.sections.map((s) => `
      <h2>${esc(s.title)}</h2>
      <table>
        <thead><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>
          ${s.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(n(v))}</td>`).join("")}</tr>`).join("")}
          ${s.total ? `<tr class="total">${s.total.map((v) => `<td>${esc(n(v))}</td>`).join("")}</tr>` : ""}
        </tbody>
      </table>
      ${s.note ? `<div class="foot">${esc(s.note)}</div>` : ""}`).join("");

  const fails = crosscheckFailures(data);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(data.title)}</h1>
  <div class="meta">기간 ${esc(data.period.from)} ~ ${esc(data.period.to)}${
    data.period.compare ? ` · 비교 ${esc(data.period.compare.from)} ~ ${esc(data.period.compare.to)}` : ""
  }</div>
  ${narration ? `<div class="lead">${esc(narration).replace(/\n+/g, "<br>")}</div>` : ""}
  <div class="panel">
    <div class="cards">${cards}</div>
    ${tables}
  </div>
  ${fails.length ? `<div class="warn">⚠️ 검산 불일치 — ${esc(fails.join(" / "))}</div>` : ""}
  <div class="foot">
    데이터 기준 — ${esc(data.sources.map((s) => `${s.what}: ${freshness(s.asOf, now)}`).join(" · "))}<br>
    ${esc(KIND_LABEL[data.kind])} · 자동 생성 초안입니다. 판단·해석은 작성자가 채워 주세요.
  </div>
</div>
</body>
</html>`;
}
