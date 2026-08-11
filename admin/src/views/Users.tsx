import { useState } from "react";
import { api, type AdminUser } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";

export function Users() {
  const [tenant, setTenant] = useState("");
  const [reason, setReason] = useState("");
  const [applied, setApplied] = useState<{ tenant: string; reason: string }>({ tenant: "", reason: "" });
  const tenants = useLoad(() => api.tenants());
  const { data, error, busy, reload } = useLoad(
    () => api.users(applied.tenant || undefined, applied.reason || undefined),
    [applied.tenant, applied.reason],
  );

  return (
    <>
      <h1>사용자</h1>
      <p className="sub">
        모든 회사의 계정. 특정 회사로 좁혀 볼 때는 <strong>사유</strong>가 필요하고, 그 열람은
        감사 로그에 남습니다.
      </p>

      <Panel
        title="계정"
        actions={
          <div className="row">
            <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
              <option value="">회사 전체</option>
              {tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
            </select>
            <input placeholder="사유 (다른 회사 조회 시)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button onClick={() => setApplied({ tenant, reason })}>조회</button>
          </div>
        }
      >
        <State busy={busy} error={error} empty={!data?.users.length}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>이메일</th><th>이름</th><th>회사</th><th>역할</th><th>상태</th><th>마지막 로그인</th><th>생성</th><th></th></tr>
              </thead>
              <tbody>
                {data?.users.map((u) => <Row key={u.id} u={u} onChanged={reload} />)}
              </tbody>
            </table>
          </div>
        </State>
      </Panel>
    </>
  );
}

function Row({ u, onChanged }: { u: AdminUser; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = u.status === "active" ? "suspended" : "active";
    const why = window.prompt(`${u.email} 을(를) ${next} 로 바꿉니다. 사유(4자 이상):`);
    if (!why) return;
    setBusy(true);
    try {
      await api.setUserStatus(u.id, next, why);
      onChanged();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{u.email}</td>
      <td>{u.name || <span className="muted">—</span>}</td>
      <td><code>{u.tenantId}</code></td>
      <td><span className={`tag${u.role === "superadmin" ? " warn" : ""}`}>{u.role}</span></td>
      <td><StatusTag status={u.status} /></td>
      <td className="muted">{when(u.lastLoginAt)}</td>
      <td className="muted">{when(u.createdAt)}</td>
      <td>
        {u.role === "superadmin"
          // superadmin 을 콘솔에서 정지시킬 수 있으면, 실수 한 번으로 아무도 못 들어오는 상태가 된다.
          ? <span className="muted">—</span>
          : <button className={u.status === "active" ? "danger" : ""} disabled={busy} onClick={toggle}>
              {u.status === "active" ? "정지" : "활성화"}
            </button>}
      </td>
    </tr>
  );
}
