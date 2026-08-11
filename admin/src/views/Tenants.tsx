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
                  {/* 크레딧은 선불이라 **잔액이 0이면 그 회사는 분석을 못 한다** — 상태만큼 중요한 값이다. */}
                  <th className="num">잔여</th><th className="num">이번 달</th>
                  <th>마지막 로그인</th><th></th>
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
  /** 행 아래에 펼쳐지는 패널. 한 번에 하나만 — 여러 개가 열리면 어느 회사 것인지 헷갈린다. */
  const [open, setOpen] = useState<"invite" | "keys" | "credits" | null>(null);

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
        {/* 잔액 0 = 분석 정지 상태다. 눈에 띄게 표시한다. */}
        <td className="num" style={t.credits <= 0 ? { color: "var(--danger, #d66)" } : undefined}>
          {t.credits.toLocaleString("ko-KR")}
        </td>
        <td className="num muted">{t.usedThisMonth.toLocaleString("ko-KR")}</td>
        <td className="muted">{t.lastLoginAt ? when(t.lastLoginAt) : "없음"}</td>
        <td>
          <div className="row">
            <button onClick={() => setOpen((v) => (v === "invite" ? null : "invite"))}>초대</button>
            <button onClick={() => setOpen((v) => (v === "keys" ? null : "keys"))}>API 키</button>
            <button onClick={() => setOpen((v) => (v === "credits" ? null : "credits"))}>크레딧</button>
            <button className={t.status === "active" ? "danger" : ""} disabled={busy} onClick={toggle}>
              {t.status === "active" ? "정지" : "활성화"}
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={11} className="wrap">
            {open === "invite" ? <InviteForm tenant={t} onClose={() => setOpen(null)} />
              : open === "keys" ? <ApiKeysPanel tenant={t} />
              : <CreditsPanel tenant={t} />}
          </td>
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
 * 회사 크레딧 — 원장 + 수동 조정.
 *
 * **원장은 지울 수 없다**(append-only 트리거). 정정도 반대 부호 행을 하나 더 쌓는 것이라,
 * 잘못 넣으면 기록이 영구히 남는다. 그래서 넣기 전에 **변경 후 잔액을 미리 보여준다** —
 * 부호를 반대로 넣는 실수가 제일 흔하다.
 */
function CreditsPanel({ tenant }: { tenant: Tenant }) {
  const { data, error, busy, reload } = useLoad(() => api.credits(tenant.id), [tenant.id]);
  const [delta, setDelta] = useState("");
  const [kind, setKind] = useState("grant");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const balance = data?.balance ?? 0;
  const n = Number(delta);
  const preview = Number.isFinite(n) && delta.trim() !== "" ? balance + Math.trunc(n) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (preview === null) return;
    if (!window.confirm(`${tenant.name}: ${balance.toLocaleString("ko-KR")} → ${preview.toLocaleString("ko-KR")} 크레딧. 진행할까요?\n\n원장은 되돌릴 수 없습니다.`)) return;
    setWorking(true); setErr(null);
    try {
      await api.adjustCredits(tenant.id, { delta: Math.trunc(n), kind, note, reason });
      setDelta(""); setNote("");
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        {data?.unit ?? "크레딧 1개 = 분석 1분"} · 현재 잔액{" "}
        <strong style={{ color: balance <= 0 ? "var(--danger, #d66)" : undefined }}>
          {balance.toLocaleString("ko-KR")}
        </strong>
        {balance <= 0 && " — 이 회사는 지금 분석을 시작할 수 없습니다."}
      </p>

      <form onSubmit={submit}>
        <div className="row">
          <input
            placeholder="증감 (예: 600 · -60)"
            value={delta}
            onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ""))}
            inputMode="numeric"
          />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {/* topup 은 없다 — 실결제가 붙은 행이라 손으로 쓰면 매출이 부풀어 보인다. */}
            <option value="grant">grant — 무상 지급</option>
            <option value="adjust">adjust — 정정</option>
            <option value="refund">refund — 환불분 회수</option>
          </select>
          <input placeholder="메모 (원장에 남습니다 · 4자 이상)" value={note} onChange={(e) => setNote(e.target.value)} />
          <input placeholder="사유 (감사용 · 4자 이상)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="primary" disabled={working || preview === null || note.trim().length < 4}>
            적용
          </button>
        </div>
        {preview !== null && (
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
            적용 후: <strong>{balance.toLocaleString("ko-KR")} → {preview.toLocaleString("ko-KR")}</strong>
            {preview < 0 && " (음수 — 받을 돈이 있다는 뜻으로 남습니다)"}
          </p>
        )}
        {err && <div className="err">{err}</div>}
      </form>

      <State busy={busy} error={error} empty={!data?.entries.length}>
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr><th>시각</th><th className="num">증감</th><th>종류</th><th>메모</th><th>처리자</th></tr>
            </thead>
            <tbody>
              {data?.entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted">{new Date(e.occurredAt).toLocaleString("ko-KR")}</td>
                  <td className="num" style={{ color: e.delta < 0 ? "var(--danger, #d66)" : undefined }}>
                    {e.delta > 0 ? "+" : ""}{e.delta.toLocaleString("ko-KR")}
                  </td>
                  <td><span className="tag">{e.reason}</span></td>
                  <td className="wrap muted">{e.note || (e.mediaId ? e.mediaId : "—")}</td>
                  <td className="muted">{e.actor || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </State>
    </div>
  );
}

/**
 * 회사별 API 키 — 고객사 **시스템**이 우리를 호출하는 열쇠.
 *
 * 사람이 쓰는 로그인과 다르다. 사람은 stepd.stepai.kr 에서 자기 워크스페이스를 보고,
 * 여기서 만든 키는 그 회사의 서버가 업로드·분석·검색을 직접 부를 때 쓴다.
 *
 * **평문은 발급 직후 한 번만 보인다.** 서버가 sha256 만 저장하기 때문에 다시 못 얻는다 —
 * 잃어버리면 폐기하고 새로 발급하는 수밖에 없다.
 */
function ApiKeysPanel({ tenant }: { tenant: Tenant }) {
  const { data, error, busy, reload } = useLoad(() => api.apiKeys(tenant.id), [tenant.id]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{ key: string; prefix: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const available = data?.scopes ?? [];

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setWorking(true); setErr(null);
    try {
      const r = await api.createApiKey(tenant.id, { name: name || undefined, scopes, reason });
      setIssued({ key: r.key, prefix: r.prefix });
      setName(""); setScopes([]);
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setWorking(false);
    }
  }

  async function revoke(id: string) {
    const why = window.prompt("이 키를 폐기합니다. 사유(4자 이상):");
    if (!why) return;
    try {
      await api.revokeApiKey(id, why);
      await reload();
    } catch (e) {
      alert(String(e));
    }
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        <strong>{tenant.name}</strong> 의 시스템이 우리 API 를 호출할 때 쓰는 키입니다.
        사람 계정과는 별개이고, 허용한 권한의 정해진 경로만 부를 수 있습니다.
      </p>

      {issued && (
        <div style={{ margin: "8px 0" }}>
          <p className="muted" style={{ marginBottom: 4, fontSize: 12 }}>
            아래 키는 <strong>지금 한 번만</strong> 보입니다. 서버는 해시만 저장하므로 다시 볼 수 없습니다.
          </p>
          <div className="row">
            <input readOnly value={issued.key} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button type="button" onClick={() => void navigator.clipboard?.writeText(issued.key)}>복사</button>
            <button type="button" onClick={() => setIssued(null)}>확인</button>
          </div>
        </div>
      )}

      <form onSubmit={create}>
        <div className="row">
          <input placeholder="키 이름 (예: 사내 업로드 서버)" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="사유 (4자 이상)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="primary" disabled={working || scopes.length === 0}>키 발급</button>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          {available.map((s) => (
            <label key={s} style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) =>
                  setScopes((prev) => (e.target.checked ? [...prev, s] : prev.filter((x) => x !== s)))
                }
              />
              <code>{s}</code>
            </label>
          ))}
          {scopes.length === 0 && (
            // 권한 없는 키는 아무것도 못 한다 — 서버도 400 으로 막지만, 누르기 전에 알려준다.
            <span className="muted" style={{ fontSize: 12 }}>권한을 하나 이상 고르세요</span>
          )}
        </div>
        {err && <div className="err">{err}</div>}
      </form>

      <State busy={busy} error={error} empty={!data?.keys.length}>
        <div className="tablewrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr><th>접두</th><th>이름</th><th>권한</th><th>마지막 사용</th><th>상태</th><th></th></tr>
            </thead>
            <tbody>
              {data?.keys.map((k) => (
                <tr key={k.id}>
                  <td><code>{k.prefix}…</code></td>
                  <td>{k.name ?? "—"}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{k.scopes.join(" · ")}</td>
                  {/* 안 쓰는 키를 회수할 근거. "없음"이면 발급만 하고 한 번도 안 쓴 키다. */}
                  <td className="muted">{k.lastUsedAt ? when(Date.parse(k.lastUsedAt)) : "없음"}</td>
                  <td>{k.revokedAt ? <span className="tag">폐기됨</span> : <StatusTag status="active" />}</td>
                  <td>
                    {!k.revokedAt && <button className="danger" onClick={() => revoke(k.id)}>폐기</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </State>
    </div>
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
          <strong>{made.name}</strong>(#{made.id}) 개설 완료 — {made.ownerEmail} 을(를) owner 로 초대했습니다
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
        {/* id 입력란은 없다 — 서버가 순번(1, 2, 3…)을 매긴다. 사람에게 의미 있는 건 이름이다. */}
        <input placeholder="회사 이름 (예: 한국방송)" value={name} onChange={(e) => setName(e.target.value)} required />
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
