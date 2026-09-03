import { useState } from "react";
import { api, type MetaEditQuery, type MetaEditStats } from "../api";
import { Panel, State, useLoad, when } from "./common";
import { TenantName } from "./tenant-name";

const FIELD_LABEL: Record<string, string> = { title: "제목", description: "설명", tags: "태그" };

/**
 * 메타 수정 로그 — **AI 원본 → 사용자 최종**. 회사가 AI 가 뽑은 제목·설명·태그를 어떻게 고쳤는지
 * 회사·장르별로 본다. 학습 데이터라 CSV/JSONL 로 내보낸다. 기본은 순수 AI→사람 페어(첫 수정)만.
 */
export function MetaEdits() {
  const [tenant, setTenant] = useState("");
  const [onlyAi, setOnlyAi] = useState(true);   // was_ai=true 만(재수정분 제외 = 순수 AI→사람)
  const [applied, setApplied] = useState<MetaEditQuery>({});
  const [exporting, setExporting] = useState(false);
  const { data, error, busy, reload } = useLoad(() => api.metadataEdits(applied), [applied]);
  // 집계는 **서버가 전체를 센다.** 프런트에서 최근 N건을 세면 어제 제목만 몰아 고친 날
  // "제목 90%" 가 되는 최근 편향이 생긴다(개선안 §2-3).
  const stats = useLoad(() => api.metadataEditStats(applied.tenant), [applied]);
  const apply = () => setApplied({ tenant: tenant.trim() || undefined });
  const rows = (data?.rows ?? []).filter((r) => !onlyAi || r.was_ai);

  async function exportCsv() {
    setExporting(true);
    try {
      const blob = await api.metadataEditsCsv(applied);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `metadata-edits-${Date.now()}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  }

  return (
    <>
      <h1>메타 수정 로그</h1>
      <p className="sub">
        AI 가 처음 뽑은 제목·설명·태그를 회사가 어떻게 고쳤는지 — <strong>회사·장르별 취향 학습 데이터</strong>입니다.
        기본은 순수 <code>AI → 사람</code> 페어(첫 수정)만 보여줍니다. 학습 파이프라인은 <code>?format=jsonl</code> 로 받습니다.
      </p>
      <StatsPanel busy={stats.busy} error={stats.error} data={stats.data} />
      <Panel
        title="metadata_edit_log"
        actions={
          <div className="row" style={{ flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <input
              placeholder="회사 id"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
            />
            <label className="row" style={{ gap: 4, alignItems: "center" }} title="그 채널의 첫 수정만 — AI 값이 원본인 순수 페어">
              <input type="checkbox" checked={onlyAi} onChange={(e) => setOnlyAi(e.target.checked)} />
              순수 AI→사람만
            </label>
            <button onClick={apply}>찾기</button>
            <button onClick={reload}>새로고침</button>
            <button onClick={() => void exportCsv()} disabled={exporting}>{exporting ? "내보내는 중…" : "CSV 내보내기"}</button>
          </div>
        }
      >
        <State busy={busy} error={error} empty={!rows.length}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>시각</th><th>회사</th><th>장르</th><th>채널·필드</th>
                  <th>AI 원본</th><th>사용자 최종</th><th>수정자</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{when(r.created_at)}</td>
                    <td><TenantName id={r.tenant_id} /></td>
                    <td className="muted">{r.genre ?? "—"}</td>
                    <td>
                      <span className="tag">{r.channel}</span> {FIELD_LABEL[r.field] ?? r.field}
                    </td>
                    <td className="wrap muted">{r.ai_original || "—"}</td>
                    <td className="wrap"><strong>{r.user_final || "—"}</strong></td>
                    <td className="muted">{r.editor ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </Panel>
    </>
  );
}

/**
 * 집계 — **분자만 말한다.**
 *
 * 개선안 목업에는 `수정률 68%` 카드가 있었다. 근거가 없다: `metadata_edit_log` 는 **고쳤을 때만**
 * 행이 생기므로 "AI 값을 그대로 쓴 건" 이 어디에도 없다 — **분모가 없다.** 없는 분모로 비율을
 * 적으면 그건 지어낸 숫자다. 그래서 비율 대신 **건수**를 적고, 분포는 "고친 것들 안에서" 라고
 * 라벨에 못 박는다(핸드오프 §3-3 의 3번 선택지).
 */
function StatsPanel({ busy, error, data }: {
  busy: boolean; error: string | null; data: MetaEditStats | null;
}) {
  if (busy) return <div className="empty">집계 불러오는 중…</div>;
  // 집계가 실패해도 아래 목록은 떠야 한다.
  if (error) return <div className="empty err">집계를 불러오지 못했습니다 ({error})</div>;
  if (!data) return null;
  const topField = data.byField[0];
  const topGenre = data.byGenre[0];
  const pctOf = (n: number) => (data.total > 0 ? `${Math.round((n / data.total) * 100)}%` : "—");
  return (
    <div className="cards">
      <div className="card">
        <div className="k">수정 페어</div>
        <div className="v">{data.total.toLocaleString("ko-KR")}건</div>
        <div className="delta muted">순수 AI→사람 {data.wasAiPairs.toLocaleString("ko-KR")}건</div>
      </div>
      <div className="card">
        <div className="k">가장 많이 고치는 필드</div>
        <div className="v">{topField ? (FIELD_LABEL[topField.field] ?? topField.field) : "—"}</div>
        <div className="delta muted">
          {topField ? `${pctOf(topField.n)} · 고친 것들 안에서` : "아직 없습니다"}
        </div>
      </div>
      <div className="card">
        <div className="k">가장 많이 고치는 장르</div>
        <div className="v">{topGenre ? topGenre.genre : "—"}</div>
        <div className="delta muted">
          {topGenre ? `${pctOf(topGenre.n)} · 고친 것들 안에서` : "아직 없습니다"}
        </div>
      </div>
    </div>
  );
}
