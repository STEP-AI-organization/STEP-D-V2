import { useState } from "react";
import { api, type MetaEditQuery } from "../api";
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
