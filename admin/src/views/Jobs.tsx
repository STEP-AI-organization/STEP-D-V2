import { useState } from "react";
import { api } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";

export function Jobs() {
  // 회사 필터. 200건 상한이라 회사가 늘면 특정 회사 잡이 목록 밖으로 밀려난다 —
  // "이 회사 것만" 볼 수 있어야 그 회사가 밀렸는지를 알 수 있다.
  const [tenant, setTenant] = useState("");
  const [applied, setApplied] = useState("");
  const { data, error, busy, reload } = useLoad(() => api.jobs(applied || undefined), [applied]);

  return (
    <>
      <h1>잡</h1>
      <p className="sub">
        {applied ? <>회사 <code>{applied}</code> 의 큐.</> : "전체 회사의 큐."} 최근 활동순 200건.
      </p>
      <Panel
        title="job_queue"
        actions={
          <div className="row">
            <input
              placeholder="회사 id (비우면 전체)"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setApplied(tenant.trim()); }}
            />
            <button onClick={() => setApplied(tenant.trim())}>필터</button>
            <button onClick={reload}>새로고침</button>
          </div>
        }
      >
        <State busy={busy} error={error} empty={!data?.jobs.length}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>타입</th><th>상태</th><th className="num">시도</th><th>회사</th><th>갱신</th><th>오류</th></tr>
              </thead>
              <tbody>
                {data?.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>{j.type}</td>
                    <td><StatusTag status={j.status} /></td>
                    <td className="num">{j.attempts}</td>
                    <td><code>{j.tenantId}</code></td>
                    <td className="muted">{when(j.updatedAt)}</td>
                    <td className="wrap muted">{j.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </Panel>
    </>
  );
}
