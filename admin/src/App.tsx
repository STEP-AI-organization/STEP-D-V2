/**
 * STEP D Admin — 플랫폼 관리 콘솔.
 *
 * 대상은 **우리(운영사)**다. 방송사 운영자가 쓰는 화면은 apps/web 이고, 여기는 그 위층 —
 * 회사를 만들고, 사람을 초대하고, 잡을 들여다보고, 누가 무엇을 열람했는지 확인한다.
 *
 * 화면 전체가 superadmin 세션 뒤에 있다. 서버가 403 을 주면 그대로 막는다 — 프런트에서
 * 권한을 판단해 숨기는 것은 편의일 뿐이고, 실제 경계는 서버(admin.ts)다.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Overview } from "./views/Overview";
import { Tenants } from "./views/Tenants";
import { Users } from "./views/Users";
import { Jobs } from "./views/Jobs";
import { Payments } from "./views/Payments";
import { Audit } from "./views/Audit";

type Tab = "overview" | "tenants" | "users" | "payments" | "jobs" | "audit";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "개요" },
  { id: "tenants", label: "회사" },
  { id: "users", label: "사용자" },
  { id: "payments", label: "결제" },
  { id: "jobs", label: "잡" },
  { id: "audit", label: "감사 로그" },
];

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  const refreshMe = useCallback(async () => {
    try {
      const r = await api.me();
      setMe(r.user);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshMe(); }, [refreshMe]);

  if (loading) return <div className="empty">불러오는 중…</div>;
  if (!me) return <Login onDone={refreshMe} />;

  // 로그인은 됐지만 superadmin 이 아닌 경우 — 서버도 막지만, 왜 막혔는지 알려준다.
  if (me.role !== "superadmin") {
    return (
      <div className="login">
        <div className="panel">
          <h1>권한 없음</h1>
          <p className="sub">
            {me.email} 은(는) <code>{me.role}</code> 입니다. 이 콘솔은 superadmin 만 사용할 수 있습니다.
          </p>
          <button onClick={async () => { await api.logout(); setMe(null); }}>로그아웃</button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">STEP D<small>ADMIN CONSOLE</small></div>
        {TABS.map((t) => (
          <button key={t.id} className="nav" data-active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="side-foot">
          <div>{me.email}</div>
          <div className="muted">superadmin</div>
          <button style={{ marginTop: 8, width: "100%" }} onClick={async () => { await api.logout(); setMe(null); }}>
            로그아웃
          </button>
        </div>
      </nav>
      <main className="main">
        {tab === "overview" && <Overview />}
        {tab === "tenants" && <Tenants />}
        {tab === "users" && <Users />}
        {tab === "payments" && <Payments />}
        {tab === "jobs" && <Jobs />}
        {tab === "audit" && <Audit />}
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.login(email, password);
      onDone();
    } catch (e) {
      // 서버가 계정 존재 여부를 구분해 주지 않는다(계정 열거 방지). 문구도 그에 맞춘다.
      setErr(e instanceof ApiError && e.status === 401 ? "이메일 또는 비밀번호가 올바르지 않습니다." : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="panel" onSubmit={submit}>
        <h1>STEP D Admin</h1>
        <p className="sub">플랫폼 관리 콘솔</p>
        <label htmlFor="email">이메일</label>
        <input id="email" type="email" autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="pw">비밀번호</label>
        <input id="pw" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} required />
        {err && <div className="err">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "확인 중…" : "로그인"}</button>
      </form>
    </div>
  );
}
