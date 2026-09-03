import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api";

/** 화면마다 반복되는 "불러오기 → 로딩/에러/데이터" 를 한 곳에 모은다. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await load());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { void run(); }, [run]);
  return { data, error, busy, reload: run };
}

export function Panel(props: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{props.title}</h2>
        <div className="spacer" />
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

export function StatusTag({ status }: { status: string }) {
  const tone =
    status === "active" || status === "done" ? "ok"
      : status === "failed" || status === "suspended" || status === "closed" ? "bad"
        : status === "running" || status === "pending" ? "warn" : "";
  return <span className={`tag ${tone}`}>{status}</span>;
}

export function when(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

export function State({ busy, error, empty, children }: {
  busy: boolean; error: string | null; empty?: boolean; children: React.ReactNode;
}) {
  if (busy) return <div className="empty">불러오는 중…</div>;
  if (error) return <div className="empty err">{error}</div>;
  if (empty) return <div className="empty">아직 없습니다.</div>;
  return <>{children}</>;
}

/** 원화 표기. 세 화면이 각자 만들고 있었다 — 한 곳에 둔다. */
export const won = (n: number) => `₩${Math.round(n).toLocaleString("ko-KR")}`;

/**
 * 아바타 색 — id 로 **결정론적으로** 고른다. 무작위면 새로고침마다 색이 바뀌어
 * "색으로 회사를 기억하는" 게 안 된다.
 */
const AVATAR_COLORS = ["#0b57d0", "#1e8e3e", "#e37400", "#9334e6", "#c5221f", "#00838f"];
export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** 이름 앞 두 글자(한글은 두 자도 넓어 한 자만). 빈 이름은 `#`. */
export function initials(name: string): string {
  const t = String(name ?? "").trim();
  if (!t) return "#";
  return /[가-힣]/.test(t[0]) ? t.slice(0, 2) : t.slice(0, 2).toUpperCase();
}

/** 회사 아바타 — 목록·인박스가 같은 모양을 쓴다(같은 회사는 어디서나 같은 색). */
export function Avatar({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
  return (
    <span
      className="avatar"
      style={{
        background: avatarColor(id), width: size, height: size,
        borderRadius: size >= 32 ? 11 : 8, fontSize: size >= 32 ? 13 : 10,
      }}
    >
      {initials(name)}
    </span>
  );
}
