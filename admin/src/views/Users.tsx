import { useState } from "react";
import { api, type AdminUser } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";
import { TenantName } from "./tenant-name";

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
        계정은 <strong>회사 단위</strong>로 만들어집니다. 그래서 회사별로 묶어서 보여줍니다 —
        한 줄로 늘어놓으면 어느 회사에 사람이 몇 명인지, 주인(owner)이 있기는 한지 알 수가 없습니다.
      </p>

      <Panel
        title="계정"
        actions={
          <div className="row">
            <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
              <option value="">회사 전체</option>
              {tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input placeholder="사유 (감사에 남습니다 · 선택)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button onClick={() => setApplied({ tenant, reason })}>조회</button>
          </div>
        }
      >
        <State busy={busy} error={error} empty={!data?.users.length}>
          {groupByTenant(data?.users ?? []).map(([tenantId, users]) => (
            <ByCompany key={tenantId} tenantId={tenantId} users={users} onChanged={reload} />
          ))}
        </State>
      </Panel>
    </>
  );
}

/** 회사별로 묶는다. 회사 안에서는 owner → admin → member 순, 그다음 이메일순. */
function groupByTenant(users: AdminUser[]): [string, AdminUser[]][] {
  const rank: Record<string, number> = { superadmin: 0, owner: 1, admin: 2, member: 3 };
  const by = new Map<string, AdminUser[]>();
  for (const u of users) {
    const list = by.get(u.tenantId) ?? [];
    list.push(u);
    by.set(u.tenantId, list);
  }
  for (const list of by.values()) {
    list.sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9) || a.email.localeCompare(b.email));
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

function ByCompany({
  tenantId, users, onChanged,
}: { tenantId: string; users: AdminUser[]; onChanged: () => void }) {
  const active = users.filter((u) => u.status === "active");
  // **주인 없는 회사**는 아무도 사람을 초대할 수 없어 사람이 갇힌다. 목록에서 바로 보여야 한다.
  const owners = active.filter((u) => u.role === "owner" || u.role === "superadmin").length;

  return (
    <div style={{ borderTop: "1px solid var(--line)" }}>
      <div
        className="row"
        style={{ padding: "10px 16px", alignItems: "baseline", gap: 8 }}
      >
        <strong><TenantName id={tenantId} /></strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {active.length}명 활성 / 전체 {users.length}명
        </span>
        {owners === 0 && (
          <span className="tag warn">owner 없음 — 이 회사는 사람을 초대할 수 없습니다</span>
        )}
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>이메일</th><th>이름</th><th>역할</th><th>상태</th><th>마지막 로그인</th><th>생성</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => <Row key={u.id} u={u} onChanged={onChanged} />)}
          </tbody>
        </table>
      </div>
    </div>
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
      {/* 회사는 그룹 머리글에 있다 — 줄마다 되풀이하면 정작 봐야 할 역할·상태가 밀린다. */}
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
