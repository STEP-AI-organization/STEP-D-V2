import { useEffect, useState } from "react";
import { api, type BusinessProfile as Profile } from "../api";
import { Panel, State, useLoad } from "./common";

const FIELDS: { key: keyof Profile; label: string; hint?: string; required?: boolean }[] = [
  { key: "bizName", label: "상호(법인명)", hint: "등기상 이름 — 화면에서 부르는 이름과 달라도 됩니다", required: true },
  { key: "bizNo", label: "사업자등록번호", hint: "10자리 · 하이픈은 넣어도 됩니다", required: true },
  { key: "ceoName", label: "대표자" },
  { key: "address", label: "사업장 주소" },
  { key: "bizType", label: "업태" },
  { key: "bizItem", label: "종목" },
  { key: "contactEmail", label: "담당자 이메일" },
  { key: "contactPhone", label: "담당자 연락처" },
];

/**
 * 회사 사업자정보 — 거래명세서의 "공급받는 자".
 *
 * **상호와 사업자등록번호만 필수**다. 다 필수로 걸면 운영자가 아무것도 못 채우고 포기한다.
 * 나머지는 비어 있으면 "덜 채워졌다"고 알려주기만 한다 — 세금계산서를 붙일 때는 전부
 * 필수가 되므로 그때 다시 채우면 된다.
 *
 * 사업자등록번호는 **서버가 검증식으로 오타를 잡는다**. 자릿수는 맞는데 틀린 번호도 걸린다.
 */
export function BusinessProfileForm({ tenantId }: { tenantId: string }) {
  const loaded = useLoad(() => api.business(tenantId), [tenantId]);
  const [form, setForm] = useState<Partial<Profile>>({});
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [badField, setBadField] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // profile 이 null 인 회사로 바뀌면 폼을 **비운다** — 이전 회사 값이 남아 있으면 그걸
    // 새 tenantId 로 저장해 남의 사업자정보가 넘어갈 수 있다(지금은 언마운트로 가려질 뿐).
    setForm(loaded.data?.profile ?? {});
  }, [loaded.data]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setBadField(null); setSaved(false);
    try {
      await api.saveBusiness(tenantId, { ...form, reason });
      setSaved(true);
      await loaded.reload();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      // 서버가 어느 칸이 문제인지 알려준다 — 그 칸을 표시해 준다.
      setBadField(e?.field ?? null);
    } finally {
      setBusy(false);
    }
  }

  const incomplete = loaded.data?.incomplete ?? [];

  return (
    <Panel title="사업자정보">
      <State busy={loaded.busy} error={loaded.error}>
        <form onSubmit={submit} style={{ padding: "12px 16px" }}>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            거래명세서의 <strong>공급받는 자</strong>에 찍힙니다.
            {incomplete.length > 0 && (
              <> 아직 비어 있음: <strong>{incomplete.join(" · ")}</strong></>
            )}
          </p>

          <div className="biz-grid">
            {FIELDS.map((f) => (
              <label key={f.key} className="biz-field">
                <span>
                  {f.label}
                  {f.required && <em> *</em>}
                </span>
                <input
                  value={String(form[f.key] ?? "")}
                  onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                  data-bad={badField === f.key || undefined}
                />
                {f.hint && <small className="muted">{f.hint}</small>}
              </label>
            ))}
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="사유 (4자 이상)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="primary" disabled={busy}>{busy ? "저장 중…" : "저장"}</button>
            {saved && <span className="muted" style={{ fontSize: 12 }}>저장했습니다.</span>}
          </div>
          {err && <div className="err">{err}</div>}
        </form>
      </State>
    </Panel>
  );
}
