import { useState } from "react";
import { api } from "../api";
import { Panel, State, useLoad } from "./common";
import { TenantName } from "./tenant-name";

const won = (n: number) => `₩${Math.round(n).toLocaleString("ko-KR")}`;

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
      <UsagePanel />
    </>
  );
}

/** 사용 원가 · 충전(매출) · 마진 — usage_events(실측 원가) vs credit_topup(충전). 회사별 상위. */
function UsagePanel() {
  const [days, setDays] = useState(30);
  const { data, error, busy } = useLoad(() => api.usage(days), [days]);
  const t = data?.totals;
  return (
    <Panel
      title="사용 원가 · 마진"
      actions={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>최근 7일</option>
          <option value={30}>최근 30일</option>
          <option value={90}>최근 90일</option>
        </select>
      }
    >
      <State busy={busy} error={error}>
        {data && (
          <>
            <div className="cards" style={{ padding: "12px 16px" }}>
              <Card k={`분석(분) · ${days}일`} v={Math.round(data.totals.minutes)} />
              <MoneyCard k="실측 원가" v={won(t!.costKrw)} />
              <MoneyCard k="충전액(매출)" v={won(t!.revenueKrw)} />
              <MoneyCard k="마진" v={won(t!.marginKrw)} tone={t!.marginKrw < 0 ? "bad" : "ok"} />
            </div>
            {data.byTenant.length === 0 ? (
              <div className="empty">기간 내 사용·충전 기록이 없습니다.</div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>회사</th><th className="num">분석(분)</th><th className="num">원가</th>
                      <th className="num">충전</th><th className="num">마진</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byTenant.map((r) => (
                      <tr key={r.tenantId}>
                        <td><TenantName id={r.tenantId} /></td>
                        <td className="num">{Math.round(r.minutes).toLocaleString("ko-KR")}</td>
                        <td className="num">{won(r.costKrw)}</td>
                        <td className="num">{won(r.revenueKrw)}</td>
                        <td className="num" style={r.marginKrw < 0 ? { color: "var(--bad)" } : undefined}>{won(r.marginKrw)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ fontSize: 11, padding: "0 16px 10px" }}>
              원가 = usage_events(실측) · 매출 = 기간 내 충전 결제(선불이라 사용 시점과 정확히 일치하진 않음).
            </p>
          </>
        )}
      </State>
    </Panel>
  );
}

function MoneyCard({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v" style={tone === "bad" ? { color: "var(--bad)" } : tone === "ok" ? { color: "var(--ok, #2f7d32)" } : undefined}>{v}</div>
    </div>
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
