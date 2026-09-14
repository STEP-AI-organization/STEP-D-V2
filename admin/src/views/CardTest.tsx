import { useState } from "react";
import { api, ApiError, type BillingCardCheck, type TestChargeResult } from "../api";
import { Panel } from "./common";

/**
 * 결제 시험 — **PG 결제창(SDK) 없이** 카드가 등록되고 실제로 긁히는지 끝까지 확인한다.
 *
 * 세 단계가 한 화면에 있는 이유: 따로 두면 "등록은 됐는데 결제가 안 된다" 를 만났을 때
 * 어디서 끊겼는지 화면을 옮겨 다니며 맞춰 봐야 한다. 여기서는 ①등록 → ②대조 → ③결제가
 * 위아래로 있어서 끊긴 지점이 그대로 보인다.
 *
 * ⚠️ **진짜 돈이 나간다.** 시험용 가짜 결제가 아니다 — 제품과 같은 서버 함수를 탄다.
 * 그래서 금액은 서버가 상한을 못박고(10크레딧 = ₩660), 여기서는 기본 1크레딧(₩66)이다.
 *
 * ⚠️ 카드번호는 **입력 즉시 서버로만** 간다. 상태에 남겨 두지 않고(발급 후 폼을 비운다)
 * 화면 어디에도 다시 그리지 않는다.
 */
export function CardTest() {
  const [tenantId, setTenantId] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "register" | "charge">("");
  const [err, setErr] = useState("");
  const [card, setCard] = useState<BillingCardCheck | null>(null);
  const [charged, setCharged] = useState<TestChargeResult | null>(null);

  // 카드 원문 — 발급에 성공하면 즉시 비운다.
  const [num, setNum] = useState("");
  const [mm, setMm] = useState("");
  const [yy, setYy] = useState("");
  const [idn, setIdn] = useState("");
  const [pw2, setPw2] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");

  const [credits, setCredits] = useState(1);
  // 서버가 4자 이상을 요구한다 — 남의 회사를 바꾸는 모든 운영자 행위의 공통 규칙이다.
  const [reason, setReason] = useState("");

  const tid = tenantId.trim();
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : String(e));

  async function check() {
    if (!tid) return setErr("회사 id 를 입력하세요.");
    setBusy("check"); setErr(""); setCharged(null);
    try { setCard(await api.billingCard(tid)); } catch (e) { setCard(null); fail(e); }
    finally { setBusy(""); }
  }

  async function register() {
    if (!tid) return setErr("회사 id 를 입력하세요.");
    setBusy("register"); setErr("");
    try {
      await api.registerBillingCard(tid, {
        credential: {
          number: num, expiryMonth: mm, expiryYear: yy,
          ...(idn.trim() ? { birthOrBusinessRegistrationNumber: idn.trim() } : {}),
          ...(pw2.trim() ? { passwordTwoDigits: pw2.trim() } : {}),
        },
        buyer: { fullName: buyerName.trim(), email: buyerEmail.trim(), phoneNumber: buyerPhone.trim() },
        reason: reason.trim(),
      });
      // 성공하면 원문을 화면에서 지운다 — 남겨 둘 이유가 없다.
      setNum(""); setMm(""); setYy(""); setIdn(""); setPw2("");
      setCard(await api.billingCard(tid));
    } catch (e) { fail(e); }
    finally { setBusy(""); }
  }

  async function charge() {
    if (!tid) return setErr("회사 id 를 입력하세요.");
    setBusy("charge"); setErr(""); setCharged(null);
    try {
      // nonce 가 포트원 멱등키의 재료다 — 버튼을 누를 때마다 새로 만든다. 같은 값으로 두 번
      // 가면 두 번 안 긁힌다(서버가 그 보호를 쓴다).
      const nonce = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      setCharged(await api.testCharge(tid, { credits, nonce, reason: reason.trim() }));
      setCard(await api.billingCard(tid));
    } catch (e) { fail(e); }
    finally { setBusy(""); }
  }

  /**
   * **왜 못 누르는지**를 계산한다.
   *
   * 처음엔 `disabled` 만 걸어 뒀는데, 그러면 화면이 아무 말도 안 해서 버튼이 고장 난 것처럼
   * 보인다(실제로 그 보고를 받았다). 조건을 줄이는 대신 **빠진 항목을 이름으로** 말한다.
   */
  const missingFor = (what: "register" | "charge"): string[] => {
    const need: (string | false)[] = [
      !tid && "회사 id",
      reason.trim().length < 4 && "사유(4자 이상)",
    ];
    if (what === "register") {
      need.push(
        !num.trim() && "카드번호",
        (!mm.trim() || !yy.trim()) && "유효기간(MM/YY)",
        // 이니시스 빌링키 결제의 필수 3종 — 없이 발급하면 결제 단계에서 거절된다.
        !buyerName.trim() && "구매자 이름",
        !buyerEmail.trim() && "구매자 이메일",
        !buyerPhone.trim() && "구매자 휴대폰",
      );
    } else {
      need.push(!card?.registered && "등록된 카드 (먼저 ①)");
    }
    return need.filter(Boolean) as string[];
  };
  const missRegister = missingFor("register");
  const missCharge = missingFor("charge");

  const won = (n: number) => `₩${n.toLocaleString("ko-KR")}`;
  // 서버의 buildTopup 과 같은 계산(공급가 60원 + 부가세 10%) — 누르기 전에 얼마인지 보인다.
  const preview = won(Math.round(credits * 60 * 1.1));

  return (
    <>
      <h1>결제 시험</h1>
      <p className="sub">
        PG 결제창 없이 <strong>카드 원문 → 빌링키 발급 → 소액 결제</strong>까지 확인합니다.
        <strong> 진짜 결제입니다</strong> — 제품과 같은 서버 경로를 타고, 크레딧도 실제로 올라갑니다.
      </p>

      {/* ⚠️ 회사 id 를 패널 헤더(actions)에 두었더니 좁은 화면에서 **잘려서 안 보였고**,
          그 상태로 없는 id 를 넣어 발급이 터졌다(2026-09-14). 본문으로 내린다. */}
      <Panel title="대상 회사">
        <div style={{ padding: "12px 16px", display: "grid", gap: 10, maxWidth: 420 }}>
          <Field label="회사 id — 실제로 있는 워크스페이스여야 합니다">
            <div className="row">
              <input
                placeholder="예: t_default"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void check(); }}
              />
              <button onClick={() => void check()} disabled={busy !== "" || !tid}>
                {busy === "check" ? "조회 중…" : "카드 확인"}
              </button>
            </div>
          </Field>
          <Field label="사유 (4자 이상 · 감사 로그에 남습니다)">
            <input placeholder="예: 신규 PG 채널 결제 확인" value={reason}
                   onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        {err && <div style={{ padding: "12px 16px", color: "var(--danger, #d66)" }}>{err}</div>}
        {card && <CardState card={card} />}
      </Panel>

      <Panel title="① 카드 등록 — 빌링키 발급 (결제창 없음)">
        <div style={{ padding: "12px 16px", display: "grid", gap: 10, maxWidth: 520 }}>
          <Field label="카드번호">
            <input inputMode="numeric" autoComplete="off" placeholder="숫자만 (13~19자리)"
                   value={num} onChange={(e) => setNum(e.target.value)} />
          </Field>
          <div className="row">
            <Field label="유효기간 월"><input inputMode="numeric" placeholder="MM" style={{ width: 70 }}
                   value={mm} onChange={(e) => setMm(e.target.value)} /></Field>
            <Field label="연도"><input inputMode="numeric" placeholder="YY" style={{ width: 70 }}
                   value={yy} onChange={(e) => setYy(e.target.value)} /></Field>
          </div>
          <Field label="생년월일 6자리 또는 사업자번호 10자리">
            <input inputMode="numeric" autoComplete="off" value={idn} onChange={(e) => setIdn(e.target.value)} />
          </Field>
          <Field label="카드 비밀번호 앞 2자리">
            <input inputMode="numeric" autoComplete="off" type="password" style={{ width: 70 }}
                   value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <hr style={{ border: 0, borderTop: "1px solid var(--line, #333)", margin: "4px 0" }} />
          {/* KG이니시스 빌링키 결제는 이 셋이 **필수**다 — 없으면 발급돼도 결제가 거절된다. */}
          <Field label="구매자 이름 (필수)">
            <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
          </Field>
          <Field label="구매자 이메일 (필수)">
            <input value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} />
          </Field>
          <Field label="구매자 휴대폰 (필수)">
            <input placeholder="01012345678" value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} />
          </Field>
          <div>
            <button onClick={() => void register()} disabled={busy !== "" || missRegister.length > 0}>
              {busy === "register" ? "발급 중…" : "빌링키 발급"}
            </button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
              {missRegister.length
                ? `남은 항목: ${missRegister.join(" · ")}`
                : "발급에 성공하면 카드번호는 화면에서 지워집니다."}
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="② 소액 결제 — 이 카드로 실제로 긁힙니다">
        <div style={{ padding: "12px 16px", display: "grid", gap: 10 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <Field label="크레딧">
              <input type="number" min={1} max={10} style={{ width: 80 }}
                     value={credits}
                     onChange={(e) => setCredits(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
            </Field>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>청구 금액(부가세 포함)</div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{preview}</div>
            </div>
            <button onClick={() => void charge()} disabled={busy !== "" || missCharge.length > 0}>
              {busy === "charge" ? "결제 중…" : "결제 실행"}
            </button>
            {missCharge.length > 0 && (
              <span className="muted" style={{ fontSize: 12 }}>남은 항목: {missCharge.join(" · ")}</span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            서버가 10크레딧(₩660)까지로 막아 둡니다 — 회사를 골라 그 회사 카드를 긁는 자리라,
            오타 하나가 큰 금액이 되지 않게 코드에 못박았습니다.
          </div>
          {charged && <ChargeResult r={charged} />}
        </div>
      </Panel>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
      {children}
    </label>
  );
}

/** 등록 상태 — **DB 와 PG 가 같은 카드를 말하는지**가 핵심이다. */
function CardState({ card }: { card: BillingCardCheck }) {
  if (!card.registered) {
    // 서버가 준 사유가 이미 완결된 문장이다 — 앞에 같은 말을 덧붙이면 두 번 나온다
    // ("등록된 카드가 없습니다 — 등록된 카드가 없습니다." 가 실제로 떴다).
    return <div style={{ padding: "12px 16px" }} className="muted">
      {card.reason || "등록된 카드가 없습니다."}
    </div>;
  }
  const buyerMissing = card.buyer
    && !(card.buyer.hasName && card.buyer.hasEmail && card.buyer.hasPhone);
  return (
    <div style={{ padding: "12px 16px", display: "grid", gap: 6, fontSize: 13 }}>
      <Row k="우리 DB" v={`${card.stored?.brand ?? "카드사 미상"} •••• ${card.stored?.last4 ?? "????"}`} />
      <Row k="PG(포트원)"
           v={card.pgError ? `조회 실패 — ${card.pgError}`
              : `${card.pg?.brand ?? "카드사 미상"} •••• ${card.pg?.last4 ?? "????"}`}
           warn={!!card.pgError} />
      {card.matches === false && (
        <Row k="대조" v="**어긋납니다** — DB 와 PG 의 카드가 다릅니다. 다시 등록하세요." warn />
      )}
      {card.matches === true && <Row k="대조" v="일치 — 이 카드로 결제할 수 있습니다." />}
      {buyerMissing && (
        <Row k="구매자 정보" v="이름·이메일·휴대폰 중 빠진 값이 있습니다 — 결제가 거절됩니다." warn />
      )}
      {card.blocked && <Row k="상태" v={card.blocked} warn />}
    </div>
  );
}

function ChargeResult({ r }: { r: TestChargeResult }) {
  return (
    <div style={{ padding: "12px 14px", border: "1px solid var(--line, #333)", borderRadius: 8, display: "grid", gap: 6, fontSize: 13 }}>
      <Row k="결과" v={r.duplicate ? "같은 요청이 이미 결제됨 (다시 긁지 않음)" : "결제 완료"} />
      <Row k="금액" v={`₩${r.amountKrw.toLocaleString("ko-KR")} (크레딧 ${r.credits}개)`} />
      {r.card && <Row k="카드" v={`${r.card.brand ?? "카드사 미상"} •••• ${r.card.last4 ?? "????"}`} />}
      <Row k="결제 id" v={r.paymentId} />
      <Row k="충전 후 잔액" v={`${r.balance.toLocaleString("ko-KR")} 크레딧`} />
    </div>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <span className="muted" style={{ minWidth: 92, fontSize: 12 }}>{k}</span>
      <span style={{ color: warn ? "var(--danger, #d66)" : undefined }}>{v}</span>
    </div>
  );
}
