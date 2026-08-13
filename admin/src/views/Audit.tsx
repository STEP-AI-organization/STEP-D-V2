import { useState } from "react";
import { api, type AuditQuery } from "../api";
import { Panel, State, useLoad, when } from "./common";
import { TenantName } from "./tenant-name";

export function Audit() {
  // 300건 상한이라 목록만으로는 되짚을 수가 없다. 운영자가 다 볼 수 있게 열어 준 만큼
  // **찾을 수 있어야** 견제가 성립한다 — 회사·검색·기간으로 좁히고, 필요하면 CSV 로 내보낸다.
  const [tenant, setTenant] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<AuditQuery>({});
  const [exporting, setExporting] = useState(false);
  const { data, error, busy, reload } = useLoad(() => api.audit(applied), [applied]);
  const apply = () => setApplied({
    tenant: tenant.trim() || undefined, q: q.trim() || undefined,
    from: from || undefined, to: to || undefined,
  });
  async function exportCsv() {
    setExporting(true);
    try {
      const blob = await api.auditCsv(applied);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `admin-audit-${Date.now()}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  }

  return (
    <>
      <h1>감사 로그</h1>
      <p className="sub">
        superadmin 이 한 일. <strong>열람도 남습니다</strong> — 유출 조사에서 정작 알고 싶은 건
        "누가 봤나"이기 때문입니다. superadmin 끼리 서로를 볼 수 있어야 견제가 성립하므로 이 화면은 공유됩니다.
      </p>
      <Panel
        title="admin_audit"
        actions={
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <input
              placeholder="회사 id"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
            />
            <input
              placeholder="검색 (행위자·동작·대상·사유)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") apply(); }}
            />
            <input type="date" title="시작일" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" title="종료일" value={to} onChange={(e) => setTo(e.target.value)} />
            <button onClick={apply}>찾기</button>
            <button onClick={reload}>새로고침</button>
            <button onClick={() => void exportCsv()} disabled={exporting}>{exporting ? "내보내는 중…" : "CSV 내보내기"}</button>
          </div>
        }
      >
        <State busy={busy} error={error} empty={!data?.entries.length}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>시각</th><th>행위자</th><th>동작</th><th>대상 회사</th><th>대상</th><th>사유</th><th>IP</th></tr>
              </thead>
              <tbody>
                {data?.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="muted">{when(e.at)}</td>
                    <td>{e.actorEmail}</td>
                    <td><span className="tag">{e.action}</span></td>
                    <td><TenantName id={e.targetTenant} /></td>
                    <td className="muted">{e.targetId ?? "—"}</td>
                    <td className="wrap">{e.reason ?? <span className="muted">—</span>}</td>
                    <td className="muted">{e.ip ?? "—"}</td>
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
