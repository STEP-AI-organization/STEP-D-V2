import { useState } from "react";
import { api, type Tenant } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";

export function Tenants() {
  const { data, error, busy, reload } = useLoad(() => api.tenants());
  const [creating, setCreating] = useState(false);

  return (
    <>
      <h1>회사</h1>
      <p className="sub">
        회사 = 데이터 소유·과금의 단위(방송사 하나). 여기서 만든 회사에 사람을 초대하면
        그 사람은 <strong>자기 회사 데이터만</strong> 보게 됩니다.
      </p>

      <Panel
        title="목록"
        actions={<button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "닫기" : "회사 추가"}
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
    // 남의 회사를 바꾸는 호출이라 서버가 사유를 요구한다 — 화면에서도 그걸 그대로 받는다.
    const reason = window.prompt(`${t.name} 을(를) ${next} 로 바꿉니다. 사유(4자 이상):`);
    if (!reason) return;
    setBusy(true);
    try {
      const r = await api.updateTenant(t.id, { status: next, reason });
      // 정지가 **실제로 끊었는지**를 숫자로 보여준다. 예전엔 상태 행만 바뀌고 로그인해 있던
      // 사람은 그대로 쓰고 있었는데, 화면상으로는 구분이 안 됐다.
      if (next === "suspended") {
        alert(`${t.name} 정지 — 진행 중이던 세션 ${r.sessionsRevoked ?? 0}개를 끊었습니다.`);
      }
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

/**
 * 회사 개설 — 회사 + 첫 관리자 초대 + 초기 크레딧을 한 번에 보낸다.
 *
 * **첫 관리자 이메일이 필수다.** 예전엔 회사만 먼저 만들고 초대는 따로였는데, 초대를
 * 빼먹거나 실패하면 아무도 못 들어가는 회사가 목록에 남았다. 서버가 셋을 한 트랜잭션으로
 * 처리하므로 여기서 한 번에 받는다.
 */
function CreateForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [kind, setKind] = useState("api");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [initialCredits, setInitialCredits] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 개설 결과. 초대 링크는 **이 화면에서만** 볼 수 있다 — 토큰은 다시 못 얻는다.
  const [made, setMade] = useState<Awaited<ReturnType<typeof api.createTenant>> | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.createTenant({
        name,
        id: id || undefined,
        kind,
        ownerEmail,
        billingEmail: billingEmail || undefined,
        initialCredits: initialCredits ? Number(initialCredits) : undefined,
      });
      setMade(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  // 만들어진 뒤에는 폼 대신 초대 링크를 보여준다. 여기서 닫으면 링크를 다시 못 본다.
  if (made) {
    const link = made.inviteUrl ?? "";
    return (
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
        <p style={{ marginTop: 0 }}>
          <strong>{made.id}</strong> 개설 완료 — {made.ownerEmail} 을(를) owner 로 초대했습니다
          {made.initialCredits > 0 && ` · 크레딧 ${made.initialCredits}개 지급`}.
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          아래 링크를 담당자에게 보내세요. <strong>이 창을 닫으면 다시 볼 수 없습니다</strong>
          (토큰은 저장하지 않습니다).
        </p>
        {link ? (
          <div className="row">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button type="button" onClick={() => void navigator.clipboard?.writeText(link)}>복사</button>
          </div>
        ) : (
          // 서버에 PUBLIC_URL 이 없으면 링크를 못 만든다 — 가짜 링크 대신 토큰을 준다.
          <div className="row">
            <input readOnly value={made.inviteToken} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 12 }}>서버 PUBLIC_URL 미설정 — 토큰만 표시</span>
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" type="button" onClick={onDone}>확인했습니다 · 닫기</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)" }}>
      <div className="row">
        <input placeholder="회사 이름 (예: 한국방송)" value={name} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="id (비우면 자동)" value={id} onChange={(e) => setId(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="api">api — 외부 API 고객</option>
          <option value="web">web — 자체 웹서비스 고객</option>
          <option value="internal">internal — 사내</option>
        </select>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          type="email"
          placeholder="첫 관리자 이메일 (필수)"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
          required
        />
        <input
          type="email"
          placeholder="청구 이메일 (선택)"
          value={billingEmail}
          onChange={(e) => setBillingEmail(e.target.value)}
        />
        <input
          inputMode="numeric"
          placeholder="초기 크레딧 (1개 = 1분)"
          value={initialCredits}
          onChange={(e) => setInitialCredits(e.target.value.replace(/\D/g, ""))}
        />
        <button className="primary" disabled={busy}>{busy ? "만드는 중…" : "만들기"}</button>
      </div>
      {err && <div className="err">{err}</div>}
      <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 10 }}>
        첫 관리자를 owner 로 초대하고 초대 링크를 돌려줍니다. 셋 중 하나라도 실패하면 회사도
        만들어지지 않습니다.
        <br />
        ⚠️ 회사가 둘 이상이 되면 <code>AUTH_REQUIRED=1</code> 없이는 서버가 모든 요청을 503 으로 막습니다
        — 인증이 꺼진 채로는 모든 요청이 기본 회사로 해석되어 격리가 무의미해지기 때문입니다.
      </p>
    </form>
  );
}
