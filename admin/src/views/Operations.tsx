import { useState } from "react";
import { api } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";
import { TenantName } from "./tenant-name";

/** Global operational inbox: only work that still needs a human decision. */
export function Operations() {
  const [tenant, setTenant] = useState("");
  const [applied, setApplied] = useState("");
  const { data, busy, error, reload } = useLoad(() => api.jobs(applied || undefined), [applied]);
  const jobs = (data?.jobs ?? []).filter((job) => job.status !== "done");
  const failed = jobs.filter((job) => job.status === "failed").length;
  const running = jobs.filter((job) => job.status === "running").length;

  async function retry(id: string) { try { await api.retryJob(id); await reload(); } catch (err) { alert(String(err)); } }
  async function remove(id: string) {
    if (!window.confirm("이 대기/실패 작업을 제거할까요?")) return;
    try { await api.removeJob(id); await reload(); } catch (err) { alert(String(err)); }
  }

  return <>
    <h1>운영 작업</h1>
    <p className="sub">완료된 기록 대신 재시도·제거 등 실제 조치가 필요한 작업만 표시합니다.</p>
    <div className="cards"><Metric k="실패" v={failed} bad /><Metric k="실행 중" v={running} /><Metric k="처리 필요" v={jobs.length} /></div>
    <Panel title="작업 큐" actions={<div className="row"><input placeholder="회사 ID" value={tenant} onChange={(e) => setTenant(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setApplied(tenant.trim()); }} /><button onClick={() => setApplied(tenant.trim())}>필터</button><button onClick={reload}>새로고침</button></div>}>
      <State busy={busy} error={error} empty={!jobs.length}><div className="tablewrap"><table><thead><tr><th>작업</th><th>회사</th><th>상태</th><th>시도</th><th>갱신</th><th>오류</th><th /></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}>
        <td>{job.type}</td><td><TenantName id={job.tenantId} /></td><td><StatusTag status={job.status} /></td><td className="num">{job.attempts}</td><td className="muted">{when(job.updatedAt)}</td><td className="wrap muted">{job.error || "—"}</td>
        <td className="row">{job.status === "failed" && <button onClick={() => void retry(job.id)}>재시도</button>}{job.status !== "running" && <button className="danger" onClick={() => void remove(job.id)}>제거</button>}</td>
      </tr>)}</tbody></table></div></State>
    </Panel>
  </>;
}
function Metric({ k, v, bad }: { k: string; v: number; bad?: boolean }) { return <div className="card"><div className="k">{k}</div><div className="v" style={bad && v > 0 ? { color: "var(--bad)" } : undefined}>{v.toLocaleString("ko-KR")}</div></div>; }
