"use client";

import { useState } from "react";
import { C, card, estimateBadge, ghostBtn, primaryBtn } from "@/lib/console/theme";
import { fmtKor } from "@/lib/console/format";
import {
  CAT_PLATS,
  PLATFORM_META,
  PLAT_PRICE_FACTOR,
  PLAT_RATE,
  PRODUCTS,
  PRODUCT_BASE_PRICE,
} from "@/lib/console/dummy";

const CTA_CHIPS = ["지금 구매하기", "최저가 보러가기", "한정 수량 구매", "상세 정보 보기"];

export function CommerceScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [deployed, setDeployed] = useState<Record<string, boolean>>({});
  const [cta, setCta] = useState<Record<string, string>>({});

  const candidatesFor = (cat: string, id: string) =>
    (CAT_PLATS[cat] || ["쿠팡", "11번가"]).map((plat) => ({
      plat,
      color: PLATFORM_META[plat],
      rate: PLAT_RATE[plat],
      price: "₩" + Math.round((PRODUCT_BASE_PRICE[id] || 10000) * (PLAT_PRICE_FACTOR[plat] || 1)).toLocaleString("ko-KR"),
    }));
  const bestPlat = (cat: string, id: string) => candidatesFor(cat, id).reduce((a, b) => (b.rate > a.rate ? b : a)).plat;

  const deployedCount = PRODUCTS.filter((p) => deployed[p.id]).length;
  const revTotal = PRODUCTS.filter((p) => deployed[p.id]).reduce((a, p) => a + p.revN, 0);

  const sel = selectedId ? PRODUCTS.find((p) => p.id === selectedId) : null;

  /* -------- DETAIL -------- */
  if (sel) {
    const cands = candidatesFor(sel.cat, sel.id);
    const chosen = links[sel.id] || bestPlat(sel.cat, sel.id);
    const isDeployed = !!deployed[sel.id];
    const chosenCta = cta[sel.id] || "지금 구매하기";
    return (
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 60px" }}>
        <div style={card({ overflow: "hidden" })}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 22px", borderBottom: `1px solid ${C.line}` }}>
            <button onClick={() => setSelectedId(null)} className="hv-soft" style={{ ...ghostBtn, padding: "7px 12px", fontSize: 12.5 }}>‹ 커머스</button>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: sel.bg, color: sel.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, flex: "0 0 40px" }}>{sel.brand.slice(0, 1)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 750, letterSpacing: "-.3px" }}>{sel.brand} · {sel.product}</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{sel.prog} · {sel.ts} 구간</div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: isDeployed ? C.green : C.violet, background: isDeployed ? C.greenSoft : C.violetSoft, padding: "4px 10px", borderRadius: 6 }}>{isDeployed ? "배포 완료" : "배포 대기"}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 24, padding: 22 }}>
            {/* preview */}
            <div>
              <div style={{ background: C.ink, borderRadius: 12, height: 300, position: "relative", overflow: "hidden", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(135deg,#222530,#222530 10px,#1B1E27 10px,#1B1E27 20px)" }} />
                <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,.12)", padding: "5px 10px", borderRadius: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3CE08F" }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#fff" }}>브랜드 인식됨</span>
                </div>
                <div style={{ position: "relative", marginBottom: 18, display: "flex", alignItems: "center", gap: 8, background: "#fff", borderRadius: 10, padding: "8px 12px" }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: sel.bg, color: sel.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>{sel.brand.slice(0, 1)}</div>
                  <div style={{ lineHeight: 1.2 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>{sel.brand}</div>
                    <div style={{ fontSize: 10.5, color: C.muted }}>{sel.ts} 노출</div>
                  </div>
                </div>
              </div>
            </div>

            {/* link match + cta + deploy */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 4 }}>외부 커머스 연결 <span style={estimateBadge}>추정</span></div>
              <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 11 }}>자동 매칭된 링크 중 선택하세요. 추천은 수수료 기준입니다.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
                {cands.map((o) => {
                  const on = o.plat === chosen;
                  const rec = o.plat === bestPlat(sel.cat, sel.id);
                  return (
                    <div key={o.plat} onClick={() => setLinks((s) => ({ ...s, [sel.id]: o.plat }))} style={{ display: "flex", alignItems: "center", gap: 11, border: on ? `2px solid ${C.violet}` : `1px solid ${C.line}`, background: on ? "#FAF9FE" : "#fff", borderRadius: 11, padding: "12px 14px", cursor: "pointer" }}>
                      <span style={{ width: 30, height: 30, borderRadius: 8, background: o.color, flex: "0 0 30px" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px" }}>{o.plat}</span>
                          {rec && <span style={{ fontSize: 9.5, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "2px 7px", borderRadius: 5 }}>추천</span>}
                        </div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>판매가 {o.price}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 13, fontWeight: 750, color: C.ink, fontFeatureSettings: "'tnum' 1" }}>{o.rate}%</div>
                        <div style={{ fontSize: 10, color: C.muted }}>수수료</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 11 }}>커머스용 편집 · 구매 유도 문구</div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 22 }}>
                {CTA_CHIPS.map((t) => {
                  const on = t === chosenCta;
                  return (
                    <button key={t} onClick={() => setCta((s) => ({ ...s, [sel.id]: t }))} style={{ ...ghostBtn, padding: "8px 13px", fontSize: 12, background: on ? C.ink : "#fff", color: on ? "#fff" : C.sub, border: on ? `1px solid ${C.ink}` : `1px solid ${C.line}` }}>{t}</button>
                  );
                })}
              </div>

              <div style={{ flex: 1, minHeight: 8 }} />
              <button onClick={() => setDeployed((s) => ({ ...s, [sel.id]: true }))} className={isDeployed ? undefined : "hv-btn-primary"} style={{ width: "100%", height: 46, border: "none", borderRadius: 11, background: isDeployed ? C.greenSoft : C.violet, color: isDeployed ? C.green : "#fff", fontSize: 13.5, fontWeight: 700, cursor: "pointer", letterSpacing: "-.2px" }}>
                {isDeployed ? "배포 완료됨 ✓" : "커머스 콘텐츠 배포"}
              </button>
              <div style={{ fontSize: 10.5, color: C.faint, marginTop: 11, lineHeight: 1.5 }}>배포 시 「표시·광고의 공정화에 관한 법률」에 따라 경제적 이해관계(제휴) 고지가 자동 삽입됩니다.</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* -------- LIST -------- */
  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 60px" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: "-.4px" }}>커머스 콘텐츠</div>
        <div style={{ fontSize: 12.5, color: C.muted, marginTop: 5 }}>스튜디오에서 인식된 브랜드를 외부 커머스에 연결해 콘텐츠로 배포하세요.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 18 }}>
        <div style={card({ padding: "17px 18px" })}>
          <div style={{ fontSize: 11.5, color: C.body, fontWeight: 600 }}>커머스 콘텐츠</div>
          <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: "-1px", marginTop: 9 }}>{PRODUCTS.length}</div>
        </div>
        <div style={card({ padding: "17px 18px" })}>
          <div style={{ fontSize: 11.5, color: C.body, fontWeight: 600 }}>배포됨</div>
          <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: "-1px", marginTop: 9 }}>{deployedCount}</div>
        </div>
        <div style={card({ padding: "17px 18px", background: "#F4F2FE", border: "1px solid #E4DEFB" })}>
          <div style={{ fontSize: 11.5, color: "#7C6FD6", fontWeight: 600 }}>배포분 예상 수익 <span style={estimateBadge}>추정</span></div>
          <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: "-1px", marginTop: 9, color: C.ink }}>₩{fmtKor(revTotal)}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
        {PRODUCTS.map((p) => {
          const chosen = links[p.id] || bestPlat(p.cat, p.id);
          const isDeployed = !!deployed[p.id];
          return (
            <div key={p.id} onClick={() => setSelectedId(p.id)} className="hv-violet" style={card({ overflow: "hidden", display: "flex", flexDirection: "column", cursor: "pointer" })}>
              <div style={{ position: "relative", height: 128, background: "repeating-linear-gradient(135deg,#F1F2F4,#F1F2F4 9px,#ECEEF2 9px,#ECEEF2 18px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 9, padding: "6px 10px" }}>
                  <div style={{ width: 22, height: 22, borderRadius: 6, background: p.bg, color: p.fg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{p.brand.slice(0, 1)}</div>
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "-.2px" }}>{p.brand}</span>
                </div>
                <span style={{ position: "absolute", top: 8, left: 8, fontSize: 9.5, fontWeight: 700, color: isDeployed ? C.green : C.violet, background: isDeployed ? C.greenSoft : C.violetSoft, padding: "3px 8px", borderRadius: 5 }}>{isDeployed ? "배포 완료" : "배포 대기"}</span>
                <span style={{ position: "absolute", bottom: 8, right: 8, fontSize: 10.5, fontWeight: 700, color: "#fff", background: "rgba(16,18,24,.78)", padding: "2px 7px", borderRadius: 5, fontFeatureSettings: "'tnum' 1" }}>{p.ts}</span>
              </div>
              <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 650, letterSpacing: "-.2px" }}>{p.product}</div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>{p.prog}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 12 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: PLATFORM_META[chosen], padding: "3px 8px", borderRadius: 6 }}>{chosen}</span>
                  <span style={{ fontSize: 11.5, color: C.body }}>수수료 {PLAT_RATE[chosen]}%</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: C.faint }}>›</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
