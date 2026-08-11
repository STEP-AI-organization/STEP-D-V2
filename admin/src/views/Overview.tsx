import { api } from "../api";
import { State, useLoad } from "./common";

export function Overview() {
  const { data, error, busy } = useLoad(() => api.overview());

  return (
    <>
      <h1>개요</h1>
      <p className="sub">플랫폼 전체 현황. 이 숫자들은 모든 회사의 합계입니다.</p>
      <State busy={busy} error={error}>
        {data && (
          <>
            <div className="cards">
              <Card k="회사" v={data.tenants} />
              <Card k="활성 사용자" v={data.users} />
              <Card k="미디어" v={data.media.count} />
              <Card k="분석된 영상(분)" v={data.media.minutes} />
            </div>
            <div className="cards">
              <Card k="대기 잡" v={data.jobs.pending ?? 0} />
              <Card k="실행 중" v={data.jobs.running ?? 0} />
              <Card k="완료" v={data.jobs.done ?? 0} />
              <Card k="실패" v={data.jobs.failed ?? 0} tone={(data.jobs.failed ?? 0) > 0 ? "bad" : undefined} />
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              영상 분(minute)은 외부 API 과금 단위이기도 합니다 — 실측 원가 기준 분당 약 ₩4.9.
            </p>
          </>
        )}
      </State>
    </>
  );
}

function Card({ k, v, tone }: { k: string; v: number; tone?: string }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v" style={tone === "bad" ? { color: "var(--bad)" } : undefined}>
        {v.toLocaleString("ko-KR")}
      </div>
    </div>
  );
}
