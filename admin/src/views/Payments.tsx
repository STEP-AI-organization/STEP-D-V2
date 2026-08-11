import { useState } from "react";
import { api } from "../api";
import { Panel, State, StatusTag, useLoad } from "./common";
import { TenantName } from "./tenant-name";

/**
 * 결제 로그 — 전 회사의 크레딧 충전 주문.
 *
 * **성공한 것만 보여주지 않는다.** `pending` 이 오래 남아 있으면 "결제창까지 갔다가 안 된 건"
 * 이고, 그게 몇 건인지가 이 화면에서 제일 중요한 정보다. 결제가 안 되는 이유(PG 설정·카드사
 * 거절)는 로그를 봐야 알지만, **몇 건이 새고 있는지**는 여기서 바로 보여야 한다.
 */
export function Payments() {
  const [tenant, setTenant] = useState("");
  const [applied, setApplied] = useState("");
  const { data, error, busy, reload } = useLoad(() => api.payments(applied || undefined), [applied]);

  const rows = data?.payments ?? [];
  const paid = rows.filter((p) => p.status === "paid");
  const stuck = rows.filter((p) => p.status === "pending");
  const krw = paid.reduce((s, p) => s + p.amountKrw, 0);

  return (
    <>
      <h1>결제</h1>
      <p className="sub">
        크레딧 충전 주문. 최근 300건. <strong>결제 = 선불 충전</strong>이고 구독이 아니라,
        여기 없는 회사는 아직 한 번도 충전한 적이 없는 회사입니다.
      </p>

      <Panel
        title="요약"
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
        <div className="row" style={{ padding: "12px 16px" }}>
          <Metric k="결제 완료" v={`${paid.length}건`} />
          <Metric k="받은 금액" v={`₩${krw.toLocaleString("ko-KR")}`} />
          {/* 대기가 쌓이면 결제창에서 이탈하고 있다는 뜻이다 — 0 이 아니면 눈에 띄어야 한다. */}
          <Metric k="미완료(대기)" v={`${stuck.length}건`} warn={stuck.length > 0} />
        </div>
      </Panel>

      <Panel title="credit_topup">
        <State busy={busy} error={error} empty={!rows.length}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>시각</th><th>회사</th><th className="num">크레딧</th><th className="num">금액</th>
                  <th>상태</th><th>요청자</th><th>결제 id</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.paymentId}>
                    <td className="muted">{fmt(p.createdAt)}</td>
                    <td><TenantName id={p.tenantId} /></td>
                    <td className="num">{p.credits.toLocaleString("ko-KR")}</td>
                    <td className="num">₩{p.amountKrw.toLocaleString("ko-KR")}</td>
                    <td><StatusTag status={p.status === "paid" ? "done" : p.status} /></td>
                    <td className="muted">{p.requestedBy || "—"}</td>
                    <td className="muted" style={{ fontSize: 11 }}><code>{p.paymentId}</code></td>
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

function Metric({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div className="muted" style={{ fontSize: 12 }}>{k}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: warn ? "var(--danger, #d66)" : undefined }}>{v}</div>
    </div>
  );
}

/** TIMESTAMPTZ 문자열 → 사람이 읽는 시각. 파싱이 깨지면 원문을 그대로 보여준다. */
function fmt(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString("ko-KR") : iso;
}
