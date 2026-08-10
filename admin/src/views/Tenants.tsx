import { useState } from "react";
import { api, type Tenant } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";

export function Tenants() {
  const { data, error, busy, reload } = useLoad(() => api.tenants());
  const [creating, setCreating] = useState(false);

  return (
    <>
      <h1>테넌트</h1>
      <p className="sub">
        테넌트 = 데이터 소유·과금의 단위(방송사 하나). 여기서 만든 테넌트에 사람을 초대하면
        그 사람은 <strong>자기 테넌트 데이터만</strong> 보게 됩니다.
      </p>

      <Panel
        title="목록"
        actions={<button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "닫기" : "새 테넌트"}
        </button>}
      >
        {creating && <CreateForm onDone={() => { setCreating(false); void reload(); }} />}
        <State busy={busy} error={error} empty={!data?.tenants.length}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>id</th><th>이름</th><th>종류</th><th>상태</th>
                  <th className="num">사용자</th><th className="num">미디어</th><th className="num">분</th>
                  <th>생성</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data?.tenants.map((t) => <Row key={t.id} t={t} onChanged={reload} />)}
              </tbody>
            </table>
          </div>
        </State>
      </Panel>
    </>
  );
}

function Row({ t, onChanged }: { t: Tenant; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(false);

  async function toggle() {
    const next = t.status === "active" ? "suspended" : "active";
    // 남의 테넌트를 바꾸는 호출이라 서버가 사유를 요구한다 — 화면에서도 그걸 그대로 받는다.
    const reason = window.prompt(`${t.name} 을(를) ${next} 로 바꿉니다. 사유(4자 이상):`);
    if (!reason) return;
    setBusy(true);
    try {
      await api.updateTenant(t.id, { status: next, reason });
      onChanged();
    } catch (e) {
      alert(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <td><code>{t.id}</code></td>
        <td>{t.name}</td>
        <td><span className="tag">{t.kind}</span></td>
        <td><StatusTag status={t.status} /></td>
        <td className="num">{t.userCount}</td>
        <td className="num">{t.mediaCount}</td>
        <td className="num">{Math.round(t.mediaSec / 60).toLocaleString("ko-KR")}</td>
        <td className="muted">{when(t.createdAt)}</td>
        <td>
          <div className="row">
            <button onClick={() => setInvite((v) => !v)}>초대</button>
            <button className={t.status === "active" ? "danger" : ""} disabled={busy} onClick={toggle}>
              {t.status === "active" ? "정지" : "활성화"}
            </button>
          </div>
        </td>
      </tr>
      {invite && (
        <tr>
          <td colSpan={9} className="wrap"><InviteForm tenant={t} onClose={() => setInvite(false)} /></td>
        </tr>
      )}
    </>
  );
}

function InviteForm({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("owner");
  const [reason, setReason] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.invite(tenant.id, email, role, reason);
      setToken(r.token);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="row">
        <input type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="owner">owner</option>
          <option value="admin">admin</option>
          <option value="member">member</option>
        </select>
        <input placeholder="사유 (4자 이상)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="primary" disabled={busy}>초대 생성</button>
        <button type="button" onClick={onClose}>닫기</button>
      </div>
      {err && <div className="err">{err}</div>}
      {token && (
        <>
          <p className="muted" style={{ marginBottom: 0 }}>
            아래 토큰은 <strong>지금 한 번만</strong> 보입니다. 메일 발송은 아직 없으니 직접 전달하세요.
            (수락: <code>POST /api/auth/accept-invite</code> · 유효기간 7일)
          </p>
          <div className="token">{token}</div>
        </>
      )}
    </form>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [kind, setKind] = useState("api");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.createTenant({ name, id: id || undefined, kind });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
      <div className="row">
        <input placeholder="이름 (예: KBS)" value={name} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="id (비우면 자동, t_ 로 시작)" value={id} onChange={(e) => setId(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="api">api — 외부 API 고객</option>
          <option value="web">web — 자체 웹서비스 고객</option>
          <option value="internal">internal — 사내</option>
        </select>
        <button className="primary" disabled={busy}>만들기</button>
      </div>
      {err && <div className="err">{err}</div>}
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
        ⚠️ 테넌트가 둘 이상이 되면 <code>AUTH_REQUIRED=1</code> 없이는 서버가 모든 요청을 503 으로 막습니다
        — 인증이 꺼진 채로는 모든 요청이 기본 테넌트로 해석되어 격리가 무의미해지기 때문입니다.
      </p>
    </form>
  );
}
