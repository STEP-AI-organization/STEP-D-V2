import { api } from "../api";
import { Panel, State, StatusTag, useLoad, when } from "./common";

export function Jobs() {
  const { data, error, busy, reload } = useLoad(() => api.jobs());

  return (
    <>
      <h1>잡</h1>
      <p className="sub">전체 회사의 큐. 최근 활동순 200건.</p>
      <Panel title="job_queue" actions={<button onClick={reload}>새로고침</button>}>
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
