import { useEffect, useState } from "react";
import { api, type AdminUser, type ApiKey, type CompanyDetail, type Tenant } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";
import { Invoice } from "./Invoice";
import { BusinessProfileForm } from "./BusinessProfile";

export function Companies({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error, busy, reload } = useLoad(() => api.tenants());
  const [creating, setCreating] = useState(false);
  return <>
    <h1>회사</h1>
    <p className="sub">회사를 열어 멤버, 성과, 결제, API 키와 운영 상태를 한곳에서 관리합니다.</p>
    <Panel title="회사 목록" actions={<button className="primary" onClick={() => setCreating(true)}>회사 추가</button>}>
      {creating && <CompanyCreate onDone={() => { setCreating(false); void reload(); }} onClose={() => setCreating(false)} />}
      <State busy={busy} error={error} empty={!data?.tenants.length}>
        <div className="tablewrap"><table><thead><tr>
          <th>회사</th><th>상태</th><th className="num">멤버</th><th className="num">잔액</th><th className="num">이번 달 사용</th><th>최근 로그인</th>
        </tr></thead><tbody>{data?.tenants.map((tenant) => <CompanyRow key={tenant.id} tenant={tenant} onOpen={onOpen} />)}</tbody></table></div>
      </State>
    </Panel>
  </>;
}

function CompanyRow({ tenant, onOpen }: { tenant: Tenant; onOpen: (id: string) => void }) {
  return <tr className="clickrow" onClick={() => onOpen(tenant.id)}>
    <td><strong>{tenant.name}</strong><div className="muted tiny">#{tenant.id}</div></td>
    <td><StatusTag status={tenant.status} /></td>
    <td className="num">{tenant.userCount}</td>
    <td className="num" style={tenant.credits <= 0 ? { color: "var(--bad)" } : undefined}>{tenant.credits.toLocaleString("ko-KR")}</td>
    <td className="num muted">{tenant.usedThisMonth.toLocaleString("ko-KR")}</td>
    <td className="muted">{tenant.lastLoginAt ? when(tenant.lastLoginAt) : "없음"}</td>
  </tr>;
}

function CompanyCreate({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [name, setName] = useState(""); const [billingEmail, setBillingEmail] = useState("");
  const [ownerName, setOwnerName] = useState(""); const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState(""); const [credits, setCredits] = useState("");
  const [kind, setKind] = useState("api");
  const [result, setResult] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const made = await api.createTenant({ name, kind, billingEmail: billingEmail || undefined, ownerName, ownerEmail, ownerPassword: password || undefined, initialCredits: credits ? Number(credits) : undefined });
      // ⚠️ 여기서 onDone() 을 부르지 않는다 — 부모가 폼을 unmount 해 자동생성 비밀번호가 화면에
      // 뜨기 전에 사라진다(서버는 평문 미보관 → 복구 불가). 확인을 눌러야 닫고 목록을 새로고침한다.
      setResult({ email: made.owner.email, password: made.temporaryPassword });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  return <div className="formbox">{result ? <Credential email={result.email} password={result.password} onClose={onDone} /> : <form onSubmit={submit}>
    <div className="formgrid">
      <label>회사명<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>유형<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="api">api · 고객사(시스템 연동)</option><option value="web">web · 고객사(화면 사용)</option><option value="internal">internal · 사내</option></select></label>
      <label>청구 연락처 이메일<input type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} /></label>
      <label>첫 담당자 이름<input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></label>
      <label>첫 담당자 이메일<input type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} required /></label>
      <label>초기 비밀번호 <span className="muted">(비우면 자동 생성)</span><input value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <label>초기 크레딧<input inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value.replace(/\D/g, ""))} /></label>
    </div>
    {error && <div className="err">{error}</div>}<div className="row"><button className="primary" disabled={busy}>{busy ? "생성 중…" : "회사와 담당자 계정 생성"}</button><button type="button" onClick={onClose}>취소</button></div>
  </form>}</div>;
}

export function CompanyPage({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const detail = useLoad(() => api.company(tenantId), [tenantId]);
  const [tab, setTab] = useState<"overview" | "performance" | "billing" | "members" | "keys" | "history">("overview");
  const data = detail.data;
  return <>
    <button className="back" onClick={onClose}>← 회사 목록</button>
    <State busy={detail.busy} error={detail.error}>{data && <>
      <div className="company-head"><div><h1>{data.tenant.name}</h1><p className="sub">#{data.tenant.id} · {data.tenant.billingEmail || "청구 연락처 미등록"}</p></div><div className="row" style={{ gap: 10, alignItems: "center" }}><StatusTag status={data.tenant.status} /><TenantStatusControls tenant={data.tenant} onChanged={detail.reload} /></div></div>
      <div className="tabs">{(["overview", "performance", "billing", "members", "keys", "history"] as const).map((id) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{labels[id]}</button>)}</div>
      {tab === "overview" && <CompanyOverview data={data} onChanged={detail.reload} />}
      {tab === "performance" && <Performance tenantId={tenantId} />}
      {tab === "billing" && <Billing tenantId={tenantId} payments={data.payments} />}
      {tab === "members" && <Members tenantId={tenantId} members={data.members} onChanged={detail.reload} />}
      {tab === "keys" && <Keys tenantId={tenantId} />}
      {tab === "history" && <History data={data} />}
    </>}</State>
  </>;
}

// 회사 정지/재개/해지 — 미납·악용 회사를 콘솔에서 끊는 자리. 서버가 status 검증 + 세션 취소를
// 처리하고(requireReason 강제), 여기서는 사유를 받아 넘기고 종료된 세션 수를 보여준다.
function TenantStatusControls({ tenant, onChanged }: { tenant: CompanyDetail["tenant"]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function setStatus(status: string, label: string) {
    const why = window.prompt(`${tenant.name} 을(를) ${label} 합니다. 사유(4자 이상, 감사에 남습니다):`);
    if (why === null) return;
    if (why.trim().length < 4) { alert("사유는 4자 이상이어야 합니다."); return; }
    if (!confirm(`정말 ${label} 할까요? — ${tenant.name}`)) return;
    setBusy(true);
    try {
      const r = await api.updateTenant(tenant.id, { status, reason: why.trim() });
      onChanged();
      alert(`${label} 완료${r.sessionsRevoked != null ? ` · 세션 ${r.sessionsRevoked}개 종료` : ""}`);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="row" style={{ gap: 6 }}>
    {tenant.status !== "active" && <button disabled={busy} onClick={() => void setStatus("active", "활성화")}>활성화</button>}
    {tenant.status === "active" && <button className="danger" disabled={busy} onClick={() => void setStatus("suspended", "정지")}>정지</button>}
    {tenant.status !== "closed" && <button className="danger" disabled={busy} onClick={() => void setStatus("closed", "해지")}>해지</button>}
  </div>;
}

const labels = { overview: "개요", performance: "성과", billing: "결제·크레딧", members: "멤버", keys: "API 키", history: "운영 이력" };
const number = (value: number) => Number(value || 0).toLocaleString("ko-KR");

function CompanyOverview({ data, onChanged }: { data: CompanyDetail; onChanged: () => void }) {
  const s = data.summary; const p = s.performance;
  return <>
    <div className="cards"><Metric k="활성 멤버" v={`${number(s.members)}명`} /><Metric k="크레딧 잔액" v={number(s.credits)} bad={s.credits <= 0} /><Metric k="이번 달 사용" v={number(s.usedThisMonth)} /><Metric k="실패 작업" v={number(s.failedJobs)} bad={s.failedJobs > 0} /></div>
    <div className="cards"><Metric k="최근 30일 조회수" v={number(p.views)} /><Metric k="시청 시간" v={`${number(p.minutesWatched)}분`} /><Metric k="순구독자" v={number(p.netSubscribers)} /><Metric k="예상 수익" v={`$${Number(p.revenue || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} /></div>
    <JobList jobs={data.jobs} onChanged={onChanged} />
  </>;
}
function Metric({ k, v, bad }: { k: string; v: string; bad?: boolean }) { return <div className="card"><div className="k">{k}</div><div className="v" style={bad ? { color: "var(--bad)" } : undefined}>{v}</div></div>; }

function JobList({ jobs, onChanged }: { jobs: CompanyDetail["jobs"]; onChanged: () => void }) {
  async function retry(id: string) { try { await api.retryJob(id); onChanged(); } catch (e) { alert(String(e)); } }
  async function remove(id: string) { if (!confirm("이 대기/실패 작업을 목록에서 제거할까요?")) return; try { await api.removeJob(id); onChanged(); } catch (e) { alert(String(e)); } }
  return <Panel title="조치가 필요한 작업"><State busy={false} error={null} empty={!jobs.length}><div className="tablewrap"><table><thead><tr><th>작업</th><th>상태</th><th>시도</th><th>최근 갱신</th><th>오류</th><th /></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td>{job.type}</td><td><StatusTag status={job.status} /></td><td className="num">{job.attempts}</td><td className="muted">{when(job.updatedAt)}</td><td className="wrap muted">{job.error || "—"}</td><td className="row">{job.status === "failed" && <button onClick={() => void retry(job.id)}>재시도</button>}{job.status !== "running" && <button className="danger" onClick={() => void remove(job.id)}>제거</button>}</td></tr>)}</tbody></table></div></State></Panel>;
}

function Performance({ tenantId }: { tenantId: string }) {
  const { data, error, busy } = useLoad(() => api.performance(tenantId), [tenantId]);
  const max = Math.max(1, ...(data?.daily.map((row) => Number(row.views)) ?? [1]));
  return <State busy={busy} error={error}>{data && <>
    <p className="sub">{data.from}부터 최근 30일 기준입니다.</p>
    {!data.channels.length ? <div className="empty">연결된 YouTube 채널이 없습니다.</div> : <>
      <div className="spark">{data.daily.map((row) => <span key={row.day} title={`${row.day}: ${number(row.views)} views`} style={{ height: `${Math.max(4, Number(row.views) / max * 100)}%` }} />)}</div>
      <Panel title="채널별 성과"><div className="tablewrap"><table><thead><tr><th>채널</th><th className="num">조회수</th><th className="num">시청 시간</th><th className="num">순구독자</th><th className="num">예상 수익</th></tr></thead><tbody>{data.channels.map((channel) => <tr key={channel.channelId}><td>{channel.channelName}</td><td className="num">{number(channel.views)}</td><td className="num">{number(channel.minutesWatched)}분</td><td className="num">{number(channel.netSubscribers)}</td><td className="num">${number(channel.revenue)}</td></tr>)}</tbody></table></div></Panel>
    </>}</>}</State>;
}

function Billing({ tenantId, payments }: { tenantId: string; payments: CompanyDetail["payments"] }) {
  const credits = useLoad(() => api.credits(tenantId), [tenantId]);
  return <>
    <Panel title="크레딧 원장"><State busy={credits.busy} error={credits.error}>{credits.data && <><div className="cards"><Metric k="현재 잔액" v={number(credits.data.balance)} bad={credits.data.balance <= 0} /></div><CreditAdjust tenantId={tenantId} balance={credits.data.balance} onChanged={credits.reload} /><div className="tablewrap"><table><thead><tr><th>시각</th><th className="num">증감</th><th>유형</th><th>메모</th><th>처리자</th></tr></thead><tbody>{credits.data.entries.map((row) => <tr key={row.id}><td className="muted">{new Date(row.occurredAt).toLocaleString("ko-KR")}</td><td className="num" style={row.delta < 0 ? { color: "var(--bad)" } : undefined}>{row.delta > 0 ? "+" : ""}{number(row.delta)}</td><td>{row.reason}</td><td className="wrap">{row.note || "—"}</td><td>{row.actor || "—"}</td></tr>)}</tbody></table></div></>}</State></Panel>
    <BusinessProfileForm tenantId={tenantId} />
    <Invoice tenantId={tenantId} />
    <Panel title="최근 결제"><div className="tablewrap"><table><thead><tr><th>시각</th><th className="num">크레딧</th><th className="num">금액</th><th>상태</th></tr></thead><tbody>{payments.map((row) => <tr key={row.paymentId}><td>{new Date(row.createdAt).toLocaleString("ko-KR")}</td><td className="num">{number(row.credits)}</td><td className="num">₩{number(row.amountKrw)}</td><td><StatusTag status={row.status === "paid" ? "done" : row.status} /></td></tr>)}</tbody></table></div></Panel>
  </>;
}
function CreditAdjust({ tenantId, balance, onChanged }: { tenantId: string; balance: number; onChanged: () => void }) {
  const [delta, setDelta] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const n = Number(delta);
  const valid = delta.trim() !== "" && delta.trim() !== "-" && Number.isFinite(n) && n !== 0;
  const next = valid ? balance + n : balance;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) { alert("증감 값을 숫자로 입력하세요 (예: 600 또는 -60)."); return; }
    if (note.trim().length < 4) { alert("메모는 4자 이상 입력하세요 (원장에 영구 기록됩니다)."); return; }
    // 원장은 append-only — 부호 오타(-600 ↔ 600)가 영구다. 결과 잔액을 사람이 눈으로 확인하게 한다.
    if (!confirm(`크레딧 ${n > 0 ? "+" : ""}${n.toLocaleString("ko-KR")} 적용\n잔액 ${balance.toLocaleString("ko-KR")} → ${next.toLocaleString("ko-KR")}\n\n원장은 되돌릴 수 없습니다. 진행할까요?`)) return;
    setBusy(true);
    try { await api.adjustCredits(tenantId, { delta: n, kind: n >= 0 ? "grant" : "adjust", note: note.trim(), reason: "운영 조정" }); setDelta(""); setNote(""); onChanged(); }
    catch (err) { alert(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  return <form className="inlineform" onSubmit={submit}>
    <input placeholder="증감 예: 600 / -60" value={delta} onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ""))} required />
    <input placeholder="메모 (4자 이상)" value={note} onChange={(e) => setNote(e.target.value)} required />
    <button disabled={busy || !valid}>적용</button>
    {valid && <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>잔액 {balance.toLocaleString("ko-KR")} → <strong style={next < 0 ? { color: "var(--bad)" } : undefined}>{next.toLocaleString("ko-KR")}</strong></span>}
  </form>;
}

function Members({ tenantId, members, onChanged }: { tenantId: string; members: AdminUser[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false); const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);
  async function reset(member: AdminUser) { try { const r = await api.resetMemberPassword(member.id); setCredential({ email: member.email, password: r.temporaryPassword }); } catch (e) { alert(e instanceof Error ? e.message : String(e)); } }
  async function remove(member: AdminUser) { if (!confirm(`${member.email} 계정을 삭제할까요?`)) return; try { await api.deleteMember(member.id); onChanged(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); } }
  async function toggleStatus(member: AdminUser) {
    const next = member.status === "active" ? "suspended" : "active"; const label = next === "suspended" ? "정지" : "활성화";
    const why = window.prompt(`${member.email} 을(를) ${label} 합니다. 사유(4자 이상):`);
    if (why === null) return;
    if (why.trim().length < 4) { alert("사유는 4자 이상이어야 합니다."); return; }
    try { await api.setUserStatus(member.id, next, why.trim()); onChanged(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
  return <><Panel title="멤버" actions={<button className="primary" onClick={() => setAdding(true)}>계정 추가</button>}>
    {adding && <MemberCreate tenantId={tenantId} onDone={(x) => { setCredential(x); setAdding(false); onChanged(); }} onClose={() => setAdding(false)} />}
    {credential && <Credential email={credential.email} password={credential.password} onClose={() => setCredential(null)} />}
    <div className="tablewrap"><table><thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>상태</th><th>최근 로그인</th><th /></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td>{member.name || "—"}</td><td>{member.email}</td><td>{member.role}</td><td><StatusTag status={member.status} /></td><td className="muted">{when(member.lastLoginAt)}</td><td className="row">{member.role !== "superadmin" && <><button className={member.status === "active" ? "danger" : ""} onClick={() => void toggleStatus(member)}>{member.status === "active" ? "정지" : "활성화"}</button><button onClick={() => void reset(member)}>비밀번호 재설정</button><button className="danger" onClick={() => void remove(member)}>삭제</button></>}</td></tr>)}</tbody></table></div>
  </Panel></>;
}
function MemberCreate({ tenantId, onDone, onClose }: { tenantId: string; onDone: (credential: { email: string; password: string }) => void; onClose: () => void }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState("member"); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); try { const r = await api.createMember(tenantId, { name, email, role, password: password || undefined }); onDone({ email: r.member.email, password: r.temporaryPassword }); } catch (err) { alert(String(err)); } finally { setBusy(false); } }
  return <form className="formbox" onSubmit={submit}><div className="formgrid"><label>이름<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>이메일<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>역할<select value={role} onChange={(e) => setRole(e.target.value)}><option value="member">member</option><option value="admin">admin</option><option value="owner">owner</option></select></label><label>초기 비밀번호 <span className="muted">(비우면 자동 생성)</span><input value={password} onChange={(e) => setPassword(e.target.value)} /></label></div><div className="row"><button className="primary" disabled={busy}>계정 생성</button><button type="button" onClick={onClose}>취소</button></div></form>;
}

function Credential({ email, password, onClose }: { email: string; password: string; onClose: () => void }) { return <div className="credential"><strong>전달용 계정 정보</strong><p className="muted">이 비밀번호는 지금만 표시됩니다. 실무자에게 직접 전달하세요.</p><div className="token">이메일: {email}<br />비밀번호: {password}</div><div className="row"><button onClick={() => void navigator.clipboard.writeText(`이메일: ${email}\n비밀번호: ${password}`)}>복사</button><button className="primary" onClick={onClose}>확인</button></div></div>; }

function Keys({ tenantId }: { tenantId: string }) {
  const { data, error, busy, reload } = useLoad(() => api.apiKeys(tenantId), [tenantId]);
  const [name, setName] = useState(""); const [scopes, setScopes] = useState<string[]>([]); const [issued, setIssued] = useState<string | null>(null);
  const available = data?.scopes ?? [];
  // 기본값은 최소 권한(읽기+미디어쓰기+검색). 서버 스코프 목록이 도착하면 한 번만 시드한다.
  useEffect(() => {
    if (available.length) setScopes((cur) => cur.length ? cur : available.filter((s) => ["media:read", "media:write", "search:read"].includes(s)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available.join(",")]);
  const toggle = (s: string) => setScopes((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!scopes.length) { alert("권한(스코프)을 최소 1개 선택하세요."); return; }
    try { const r = await api.createApiKey(tenantId, { name, scopes, reason: "키 발급" }); setIssued(r.key); setName(""); reload(); }
    catch (err) { alert(err instanceof Error ? err.message : String(err)); }
  }
  async function revoke(key: ApiKey) { if (!confirm(`${key.name || key.prefix} 키를 폐기할까요?`)) return; try { await api.revokeApiKey(key.id, "운영 폐기"); reload(); } catch (err) { alert(err instanceof Error ? err.message : String(err)); } }
  async function rotate(key: ApiKey) { if (!confirm(`${key.name || key.prefix} 키를 회전합니다 — 같은 권한으로 새 키를 발급하고 이 키를 폐기합니다. 계속?`)) return; try { const r = await api.rotateApiKey(key.id, "키 회전"); setIssued(r.key); reload(); } catch (err) { alert(err instanceof Error ? err.message : String(err)); } }
  return <Panel title="API 키">
    <p className="sub">고객사 <strong>시스템</strong>이 우리를 호출하는 키입니다. <strong>필요한 권한만</strong> 골라 최소로 발급하세요 — 평문은 발급 직후 한 번만 표시됩니다.</p>
    {issued && <Credential email="API key" password={issued} onClose={() => setIssued(null)} />}
    <form onSubmit={create}>
      <div className="inlineform"><input placeholder="키 이름 예: 고객사 운영 서버" value={name} onChange={(e) => setName(e.target.value)} required /><button className="primary" disabled={!scopes.length}>키 발급</button></div>
      <div className="row" style={{ flexWrap: "wrap", gap: 12, margin: "8px 0 2px" }}>
        {available.length ? available.map((s) => <label key={s} className="row" style={{ gap: 5, fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} /><code>{s}</code></label>) : <span className="muted">권한 목록 불러오는 중…</span>}
      </div>
    </form>
    <State busy={busy} error={error} empty={!data?.keys.length}><div className="tablewrap"><table><thead><tr><th>이름</th><th>접두사</th><th>권한</th><th>마지막 사용</th><th>상태</th><th /></tr></thead><tbody>{data?.keys.map((key) => <tr key={key.id}><td>{key.name || "—"}</td><td><code>{key.prefix}…</code></td><td className="muted" style={{ fontSize: 11 }}>{key.scopes?.join(" · ") || "—"}</td><td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString("ko-KR") : "없음"}</td><td>{key.revokedAt ? "폐기됨" : "활성"}</td><td className="row">{!key.revokedAt && <><button onClick={() => void rotate(key)}>회전</button><button className="danger" onClick={() => void revoke(key)}>폐기</button></>}</td></tr>)}</tbody></table></div></State>
  </Panel>;
}

function History({ data }: { data: CompanyDetail }) { return <Panel title="운영 이력"><State busy={false} error={null} empty={!data.audit.length}><div className="timeline">{data.audit.map((row) => <div className="event" key={row.id}><strong>{row.action}</strong><span>{row.actorEmail}</span><span>{when(row.at)}</span>{row.reason && <p>{row.reason}</p>}</div>)}</div></State></Panel>; }
