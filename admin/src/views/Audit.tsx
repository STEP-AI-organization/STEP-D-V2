import { useState } from "react";
import { api } from "../api";
import { Panel, State, useLoad, when } from "./common";
import { TenantName } from "./tenant-name";

export function Audit() {
  // 300건 상한이라 목록만으로는 되짚을 수가 없다. 운영자가 다 볼 수 있게 열어 준 만큼
  // **찾을 수 있어야** 견제가 성립한다 — 회사로 좁히거나 행위자·동작·대상으로 검색한다.
  const [tenant, setTenant] = useState("");
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState<{ tenant?: string; q?: string }>({});
  const { data, error, busy, reload } = useLoad(() => api.audit(applied), [applied]);
  const apply = () => setApplied({ tenant: tenant.trim() || undefined, q: q.trim() || undefined });

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
          <div className="row">
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
            <button onClick={apply}>찾기</button>
            <button onClick={reload}>새로고침</button>
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
