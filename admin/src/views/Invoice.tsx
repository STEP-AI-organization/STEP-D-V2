import { useState } from "react";
import { api } from "../api";
import { Panel, State, useLoad } from "./common";

/**
 * 인보이스(거래명세서) — 회사에 줄 문서.
 *
 * ⚠️ **세금계산서가 아니다.** 그건 국세청 신고가 필요한 법정 증빙이라 별도 발행 서비스가
 * 있어야 한다. 문서에도 그 사실을 적어 둔다 — 아닌 걸 그렇게 부르면 상대가 그걸로
 * 회계 처리를 하려다 문제가 생긴다.
 *
 * PDF 를 서버에서 만들지 않는다. **브라우저 인쇄(Ctrl+P → PDF 저장)** 로 충분하고,
 * PDF 라이브러리를 넣으면 한글 폰트 임베딩부터 새 문제가 줄줄이 딸려온다.
 * 대신 인쇄용 CSS 를 붙여 화면 크롬(탭·버튼)이 종이에 안 찍히게 한다.
 */
export function Invoice({ tenantId }: { tenantId: string }) {
  const months = useLoad(() => api.invoiceMonths(tenantId), [tenantId]);
  const [month, setMonth] = useState<string | null>(null);
  const picked = month ?? months.data?.months[0]?.month ?? null;
  const doc = useLoad(
    () => (picked ? api.invoice(tenantId, picked) : Promise.resolve(null)),
    [tenantId, picked],
  );

  return (
    <Panel
      title="인보이스"
      actions={
        <div className="row no-print">
          <select value={picked ?? ""} onChange={(e) => setMonth(e.target.value)}>
            {months.data?.months.map((m) => (
              <option key={m.month} value={m.month}>
                {m.month} · {m.paid}건 · ₩{m.totalKrw.toLocaleString("ko-KR")}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!doc.data} onClick={() => window.print()}>
            인쇄 · PDF 저장
          </button>
        </div>
      }
    >
      <State busy={months.busy || doc.busy} error={months.error || doc.error} empty={!months.data?.months.length}>
        {doc.data && (
          <div className="invoice">
            {doc.data.issuerMissing.length > 0 && (
              // 없는 값을 지어내지 않는다. 대신 무엇을 채워야 하는지 말한다.
              <p className="err no-print">
                발행자 정보가 비어 있습니다: <code>{doc.data.issuerMissing.join(", ")}</code> —
                서버 env 에 설정하면 문서에 찍힙니다.
              </p>
            )}

            <header className="invoice-head">
              <div>
                {/* 공식 자산 그대로. 로고를 흉내내 그리지 않는다. */}
                <img src="/brand/stepai-logo.png" alt="" width={40} height={40} />
                <h2>거래명세서</h2>
                <p className="muted">{doc.data.note}</p>
              </div>
              <div className="invoice-no">
                <div><strong>{doc.data.invoice.number}</strong></div>
                <div className="muted">{doc.data.invoice.monthKey}</div>
              </div>
            </header>

            <div className="invoice-parties">
              <section>
                <h3>공급자</h3>
                <div>{doc.data.issuer.name || <span className="muted">— 미설정</span>}</div>
                <div className="muted">{doc.data.issuer.bizNo || "사업자번호 미설정"}</div>
                {doc.data.issuer.address && <div className="muted">{doc.data.issuer.address}</div>}
                {doc.data.issuer.contact && <div className="muted">{doc.data.issuer.contact}</div>}
              </section>
              <section>
                <h3>공급받는 자</h3>
                <div>{doc.data.customer.name}</div>
                <div className="muted">{doc.data.customer.billingEmail || "청구 이메일 미설정"}</div>
              </section>
            </div>

            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>일자</th><th>내역</th><th className="num">수량</th><th className="num">금액</th></tr>
                </thead>
                <tbody>
                  {doc.data.invoice.lines.map((l) => (
                    <tr key={l.paymentId}>
                      <td>{l.date}</td>
                      <td>{l.desc}</td>
                      <td className="num">{l.credits.toLocaleString("ko-KR")}</td>
                      <td className="num">₩{l.amountKrw.toLocaleString("ko-KR")}</td>
                    </tr>
                  ))}
                  {doc.data.invoice.lines.length === 0 && (
                    <tr><td colSpan={4} className="muted">이 달에 결제된 건이 없습니다.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* 공급가액 + 세액 = 총액. 총액은 **실제 결제액**과 항상 같다. */}
            <div className="invoice-total">
              <div><span className="muted">공급가액</span> ₩{doc.data.invoice.supplyKrw.toLocaleString("ko-KR")}</div>
              <div><span className="muted">부가세</span> ₩{doc.data.invoice.vatKrw.toLocaleString("ko-KR")}</div>
              <div className="grand"><span>합계</span> ₩{doc.data.invoice.totalKrw.toLocaleString("ko-KR")}</div>
            </div>
          </div>
        )}
      </State>
    </Panel>
  );
}
