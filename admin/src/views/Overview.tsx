import { useState } from "react";
import { api, type UsageTrendPoint } from "../api";
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
            {/* ⚠️ 예전엔 여기 "분당 약 ₩4.9" 가 **박혀** 있었다. flash-lite 전환 뒤 실측은 분당
                ₩11 대다 — 화면이 두 배 넘게 틀린 값을 말하고 있었다. 원가는 어디에도 박지 말고
                usage 에서 읽는다(CLAUDE.md: 원가를 인용하기 전에 실제로 조회했는지 확인할 것). */}
            <p className="muted" style={{ fontSize: 12 }}>
              영상 분(minute)은 외부 API 과금 단위이기도 합니다 — 지금 단가는 아래 <b>60분당 원가(실측)</b>에서 봅니다.
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
  // 추이는 **따로** 부른다 — 합계 카드는 이게 실패해도 떠야 한다(차트 하나 때문에 화면을
  // 통째로 막지 않는다). 그래서 error 도 따로 받는다.
  const trend = useLoad(() => api.usageTrend(days), [days]);
  const t = data?.totals;
  const prev = trend.data?.previous;
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
              <MoneyCard k="원가" v={won(t!.costKrw)} delta={delta(t!.costKrw, prev?.costKrw)} lowerIsBetter />
              <MoneyCard k="충전액(매출)" v={won(t!.revenueKrw)} delta={delta(t!.revenueKrw, prev?.revenueKrw)} />
              <MoneyCard k="마진" v={won(t!.marginKrw)} tone={t!.marginKrw < 0 ? "bad" : "ok"}
                delta={delta(t!.marginKrw, prev?.marginKrw)} />
              {/* 마진 감시의 본체는 총액이 아니라 **단가**다. 총액은 물량이 늘면 같이 늘어서
                  구성 변화(모델 교체·스테이지 on/off)를 가린다. */}
              {/* 원가는 **내려가는 게 좋다** — 다른 카드와 반대라 델타 색을 뒤집는다. */}
              <MoneyCard
                k="60분당 원가 (실측)"
                v={t!.costPer60minKrw != null ? won(t!.costPer60minKrw) : "—"}
                delta={delta(t!.costPer60minKrw, prev?.costPer60minKrw)}
                lowerIsBetter
              />
              <MoneyCard
                k="실측 비중"
                v={`${Math.round(t!.measuredRatio * 100)}%`}
                tone={t!.measuredRatio < 0.5 ? "bad" : "ok"}
              />
            </div>
            {/* 추이 — 합계만 보면 "물량이 늘어 총액도 늘었다" 와 "단가가 올랐다" 를 구분 못 한다. */}
            <TrendPanel busy={trend.busy} error={trend.error} points={trend.data?.points ?? []} days={days} />

            {data.byTenant.length === 0 ? (
              <div className="empty">기간 내 사용·충전 기록이 없습니다.</div>
            ) : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>회사</th><th className="num">분석(분)</th><th className="num">원가</th>
                      <th className="num">60분당</th>
                      <th className="num">충전</th><th className="num">마진</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byTenant.map((r) => (
                      <tr key={r.tenantId}>
                        <td><TenantName id={r.tenantId} /></td>
                        <td className="num">{Math.round(r.minutes).toLocaleString("ko-KR")}</td>
                        <td className="num">{won(r.costKrw)}</td>
                        <td className="num">{r.costPer60minKrw != null ? won(r.costPer60minKrw) : "—"}</td>
                        <td className="num">{won(r.revenueKrw)}</td>
                        <td className="num" style={r.marginKrw < 0 ? { color: "var(--bad)" } : undefined}>{won(r.marginKrw)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ fontSize: 11, padding: "0 16px 10px" }}>
              원가 = usage_events · 매출 = 기간 내 충전 결제(선불이라 사용 시점과 정확히 일치하진 않음).
              <br />
              <b>60분당 원가</b>는 <b>인프라 제외</b>(Gemini·받아쓰기 등 벤더 실비)이고, core 가 회차마다 남긴
              usage.json 실측으로 기록된 행만으로 계산한다 — 서버·GPU VM 같은 고정비는 여기 없다.
              <b>실측 비중</b>이 낮으면 나머지는 상수 폴백이라 단가 표본이 얇다는 뜻이다(옛 회차는 소급하지 않는다).
            </p>
          </>
        )}
      </State>
    </Panel>
  );
}

/**
 * 직전 같은 길이 구간 대비 변화율. **비교 대상이 없거나 0 이면 null** — 0 에서 늘어난 걸
 * "+100%" 라고 적으면 거짓말이다.
 */
function delta(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null || before === 0) return null;
  return Math.round(((now - before) / Math.abs(before)) * 100);
}

function MoneyCard({ k, v, tone, delta: d, lowerIsBetter }: {
  k: string; v: string; tone?: string; delta?: number | null; lowerIsBetter?: boolean;
}) {
  const good = d == null || d === 0 ? null : lowerIsBetter ? d < 0 : d > 0;
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v" style={tone === "bad" ? { color: "var(--bad)" } : tone === "ok" ? { color: "var(--ok, #2f7d32)" } : undefined}>{v}</div>
      {d != null && (
        <div className="delta" style={{ color: good == null ? "var(--muted)" : good ? "var(--ok)" : "var(--bad)" }}>
          {d > 0 ? "\u25b2" : d < 0 ? "\u25bc" : ""} {Math.abs(d)}% <span className="muted">vs 이전 기간</span>
        </div>
      )}
    </div>
  );
}

/**
 * 60분당 원가 추이 — **마진 감시의 본체.**
 *
 * 차트 라이브러리를 넣지 않는다. 선 하나 그리자고 의존성을 늘릴 이유가 없고, 이 콘솔의
 * 의존성은 react + react-dom 둘뿐이다.
 *
 * 왜 총액이 아니라 단가인가: 총액은 물량이 늘면 같이 늘어서 **구성 변화**(모델 교체·스테이지
 * on/off)를 가린다. 마진이 무너지는 건 단가에서 먼저 보인다.
 *
 * 실측이 없는 날은 **선을 끊는다.** 0 으로 이으면 "그날 원가가 0원" 처럼 보인다 —
 * 없는 것과 0 은 다르다.
 */
function TrendPanel({ busy, error, points, days }: {
  busy: boolean; error: string | null; points: UsageTrendPoint[]; days: number;
}) {
  const withCost = points.filter((p) => p.costPer60minKrw != null);
  if (busy) return <div className="empty">추이 불러오는 중…</div>;
  // 추이가 실패해도 위 합계 카드는 이미 떠 있다 — 여기서 화면 전체를 막지 않는다.
  if (error) return <div className="empty err">추이를 불러오지 못했습니다 ({error})</div>;
  if (withCost.length < 2) {
    return (
      <div className="empty">
        최근 {days}일에 <b>실측 원가가 기록된 날이 {withCost.length}일</b>뿐이라 추이를 그릴 수 없습니다
        (2일 이상 필요). 실측 기록은 core 가 usage.json 을 남기기 시작한 시점부터 쌓입니다.
      </div>
    );
  }

  const W = 720;
  const H = 140;
  const PAD = 28;
  const vals = withCost.map((p) => p.costPer60minKrw as number);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);

  // 실측이 있는 구간만 이어 그린다 — 빈 날에서 선을 끊는다.
  const segments: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    if (p.costPer60minKrw == null) {
      if (cur.length > 1) segments.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${cur.length ? "L" : "M"}${x(i).toFixed(1)},${y(p.costPer60minKrw).toFixed(1)}`);
  });
  if (cur.length > 1) segments.push(cur.join(" "));

  return (
    <div style={{ padding: "4px 16px 12px" }}>
      <div className="k" style={{ marginBottom: 6 }}>60분당 원가 추이 (실측 · 원)</div>
      <svg
        viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 140 }} role="img"
        aria-label={`60분당 원가 추이 · 최저 ${Math.round(lo)}원 최고 ${Math.round(hi)}원`}
      >
        <line x1={PAD} y1={y(hi)} x2={W - PAD} y2={y(hi)} stroke="var(--line)" />
        <line x1={PAD} y1={y(lo)} x2={W - PAD} y2={y(lo)} stroke="var(--line)" />
        <text x={4} y={y(hi) + 4} fontSize="10" fill="var(--muted)">{Math.round(hi)}</text>
        <text x={4} y={y(lo) + 4} fontSize="10" fill="var(--muted)">{Math.round(lo)}</text>
        {segments.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        ))}
        {points.map((p, i) => (p.costPer60minKrw == null ? null : (
          <circle key={p.day} cx={x(i)} cy={y(p.costPer60minKrw)} r="2.5" fill="var(--accent)">
            <title>{`${p.day} · 60분당 ${Math.round(p.costPer60minKrw)}원 · 실측비중 ${Math.round(p.measuredRatio * 100)}%`}</title>
          </circle>
        )))}
        <text x={PAD} y={H - 6} fontSize="10" fill="var(--muted)">{points[0]?.day ?? ""}</text>
        <text x={W - PAD} y={H - 6} fontSize="10" fill="var(--muted)" textAnchor="end">
          {points[points.length - 1]?.day ?? ""}
        </text>
      </svg>
      <p className="muted" style={{ fontSize: 11, marginTop: 2 }}>
        실측 기록이 없는 날은 <b>선을 끊습니다</b> — 0 으로 이으면 그날 원가가 0원인 것처럼 보입니다.
        날짜는 KST 기준입니다.
      </p>
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
