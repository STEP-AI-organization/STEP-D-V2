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
