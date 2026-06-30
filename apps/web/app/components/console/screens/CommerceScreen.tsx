"use client";

import { useEffect, useMemo, useState } from "react";
import { C, card, estimateBadge, ghostBtn } from "@/lib/console/theme";
import { fmtKor } from "@/lib/console/format";
import { CAT_PLATS, PLATFORM_META, PLAT_RATE } from "@/lib/console/dummy";
import { useConsole, type CommerceItem } from "../ConsoleProvider";
import { PplOverlayPlayer } from "../PplOverlayPlayer";

const CTA_CHIPS = ["지금 구매하기", "최저가 보러가기", "한정 수량 구매", "상세 정보 보기"];
const DEMO_FALLBACK_PLATFORMS = ["쿠팡", "11번가", "올리브영"];

// Map a free-form PPL category to one of our platform groups.
const catGroup = (cat: string): keyof typeof CAT_PLATS | "기타" => {
  const c = cat || "";
  if (/뷰티|화장|코스메|패션|의류|뷰/.test(c)) return "패션·뷰티";
  if (/식품|음료|음식|먹|푸드|식/.test(c)) return "식품";
  if (/전자|IT|가전|디지털|폰|테크/i.test(c)) return "전자·IT";
  if (/스포츠|운동|레저/.test(c)) return "스포츠";
  if (/리빙|생활|주방|가구|home/i.test(c)) return "리빙";
  return "기타";
};
const candidatesFor = (cat: string): string[] => CAT_PLATS[catGroup(cat) as keyof typeof CAT_PLATS] || DEMO_FALLBACK_PLATFORMS;
const highestRatePlat = (cat: string) => candidatesFor(cat).reduce((a, b) => (PLAT_RATE[b] > PLAT_RATE[a] ? b : a));
const recommendedPlatFor = (item: Pick<CommerceItem, "category">, index = 0) => {
  const group = catGroup(item.category);
  if (group === "기타") return DEMO_FALLBACK_PLATFORMS[index % DEMO_FALLBACK_PLATFORMS.length];

  const categoryDefault: Partial<Record<keyof typeof CAT_PLATS, string>> = {
    식품: "쿠팡",
    "전자·IT": "쿠팡",
    리빙: "쿠팡",
    스포츠: "쿠팡",
    "패션·뷰티": "올리브영",
  };
  const preferred = categoryDefault[group];
  return preferred && candidatesFor(item.category).includes(preferred) ? preferred : highestRatePlat(item.category);
};

// Real, persistable affiliate search URL (partner-id tagging needs the actual account).
const platUrl = (plat: string, brand: string, product: string): string => {
  const q = encodeURIComponent(`${brand} ${product}`.trim());
  switch (plat) {
    case "쿠팡": return `https://www.coupang.com/np/search?q=${q}`;
    case "올리브영": return `https://www.oliveyoung.co.kr/store/search/getSearchMain.do?query=${q}`;
    case "무신사": return `https://www.musinsa.com/search/musinsa/integration?q=${q}`;
    case "11번가": return `https://search.11st.co.kr/Search.tmall?kwd=${q}`;
    default: return `https://www.google.com/search?q=${q}`;
  }
};
const estRevenue = (exposure: number, voiceMentions: number, rate: number) =>
  Math.round((exposure * 135000 + voiceMentions * 27000) * (rate / 100));

export function CommerceScreen() {
  const c = useConsole();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const thumbFor = (clipId: string) => c.pickerClips.find((p) => p.clipId === clipId)?.thumb ?? null;
  const videoFor = (clipId: string) => c.pickerClips.find((p) => p.clipId === clipId)?.videoUrl ?? null;
  const [linkPlat, setLinkPlat] = useState<Record<string, string>>({});
  const [deployed, setDeployed] = useState<Record<string, boolean>>({});
  const [cta, setCta] = useState<Record<string, string>>({});
  const [showAnalyze, setShowAnalyze] = useState(false);

  useEffect(() => {
    if (!c.commerceLoaded && !c.commerceLoading && c.projects.length) void c.loadCommerce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.commerceLoaded, c.projects.length]);

  const items = c.commerceItems;
  const linkedCount = items.filter((i) => i.affiliateUrl).length;
  const revTotal = useMemo(
    () => items.reduce((a, i, index) => a + estRevenue(i.exposure, i.voiceMentions, PLAT_RATE[linkPlat[i.key] || recommendedPlatFor(i, index)] || 3), 0),
    [items, linkPlat]
  );

  const sel = selectedKey ? items.find((i) => i.key === selectedKey) : null;

  /* -------- DETAIL -------- */
  if (sel) {
    const selIndex = Math.max(0, items.findIndex((i) => i.key === sel.key));
    const cands = candidatesFor(sel.category);
    const recommended = recommendedPlatFor(sel, selIndex);
    const chosen = linkPlat[sel.key] || recommended;
    const isDeployed = !!deployed[sel.key];
    const chosenCta = cta[sel.key] || "지금 구매하기";
    const rate = PLAT_RATE[chosen] || 3;
    return (
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 60px" }}>
        <div style={card({ overflow: "hidden" })}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 22px", borderBottom: `1px solid ${C.line}` }}>
            <button onClick={() => setSelectedKey(null)} className="hv-soft" style={{ ...ghostBtn, padding: "7px 12px", fontSize: 12.5 }}>‹ 커머스</button>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: C.violetSoft2, color: C.violet, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, flex: "0 0 40px" }}>{sel.brand.slice(0, 1)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 750, letterSpacing: "-.3px" }}>{sel.brand} · {sel.product}</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{sel.projectTitle} · {sel.clipTitle}</div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: isDeployed ? C.green : C.violet, background: isDeployed ? C.greenSoft : C.violetSoft, padding: "4px 10px", borderRadius: 6 }}>{isDeployed ? "배포 완료" : "배포 대기"}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 28, padding: 22 }}>
            {/* preview + real recognition meta */}
            <div>
              {(() => {
                const videoUrl = sel.videoUrl ?? videoFor(sel.clipId) ?? undefined;
                const thumb = sel.thumbnail ?? thumbFor(sel.clipId) ?? undefined;
                // 단일 브랜드 오버레이(이 브랜드의 박스만) — 프레임 좌표가 있을 때
                if (sel.overlay && sel.overlay.frames.length) {
                  return (
                    <div style={{ position: "relative", maxWidth: 380, margin: "0 auto" }}>
                      <div style={{ position: "absolute", top: 12, left: 12, zIndex: 3, display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.55)", backdropFilter: "blur(6px)", padding: "5px 10px", borderRadius: 8, pointerEvents: "none" }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3CE08F" }} />
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#fff" }}>{sel.brand} 인식 · 오버레이</span>
                      </div>
                      <PplOverlayPlayer analysis={sel.overlay} videoUrl={videoUrl} poster={thumb} maxWidth={380} />
                    </div>
                  );
                }
                return (
                  <div style={{ borderRadius: 14, overflow: "hidden", background: C.ink, position: "relative", aspectRatio: "9 / 16", maxHeight: 620 }}>
                    {videoUrl ? (
                      <video
                        src={videoUrl}
                        poster={thumb ?? undefined}
                        controls
                        playsInline
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    ) : thumb ? (
                      <img src={thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    ) : (
                      <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(135deg,#222530,#222530 10px,#1B1E27 10px,#1B1E27 20px)" }} />
                    )}
                    {/* AI 인식 배지 */}
                    <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.55)", backdropFilter: "blur(6px)", padding: "5px 10px", borderRadius: 8, pointerEvents: "none" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#3CE08F" }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#fff" }}>브랜드 인식됨 (AI)</span>
                    </div>
                    {/* 브랜드 레이블 - 비디오 없을 때만 */}
                    {!videoUrl && (
                      <div style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,.93)", borderRadius: 10, padding: "7px 12px", boxShadow: "0 2px 12px rgba(0,0,0,.22)" }}>
                        <div style={{ width: 24, height: 24, borderRadius: 6, background: C.violetSoft2, color: C.violet, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>{sel.brand.slice(0, 1)}</div>
                        <div style={{ lineHeight: 1.2 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{sel.brand}</div>
                          <div style={{ fontSize: 10.5, color: C.muted }}>노출 {sel.exposure.toFixed(1)}초</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
                <Stat label="화면 노출" value={`${sel.exposure.toFixed(1)}초`} />
                <Stat label="음성 언급" value={`${sel.voiceMentions}회`} />
                <Stat label="인식 신뢰도" value={`${Math.round(sel.confidence * 100)}%`} />
                <Stat label="카테고리" value={sel.category || "기타"} />
              </div>
            </div>

            {/* link match + cta + deploy */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 4 }}>외부 커머스 연결</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 11 }}>플랫폼을 고르면 검색 링크가 클립에 저장됩니다. 수수료·예상 수익은 <span style={estimateBadge}>추정</span>입니다.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
                {cands.map((o) => {
                  const on = o === chosen;
                  const rec = o === recommended;
                  return (
                    <div key={o} onClick={() => setLinkPlat((s) => ({ ...s, [sel.key]: o }))} style={{ display: "flex", alignItems: "center", gap: 11, border: on ? `2px solid ${C.violet}` : `1px solid ${C.line}`, background: on ? "#FAF9FE" : "#fff", borderRadius: 11, padding: "12px 14px", cursor: "pointer" }}>
                      <span style={{ width: 30, height: 30, borderRadius: 8, background: PLATFORM_META[o] || C.muted, flex: "0 0 30px" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "-.2px" }}>{o}</span>
                          {rec && <span style={{ fontSize: 9.5, fontWeight: 700, color: C.green, background: C.greenSoft, padding: "2px 7px", borderRadius: 5 }}>추천</span>}
                        </div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>예상 수익 ₩{fmtKor(estRevenue(sel.exposure, sel.voiceMentions, PLAT_RATE[o] || 3))} <span style={estimateBadge}>추정</span></div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 13, fontWeight: 750, color: C.ink, fontFeatureSettings: "'tnum' 1" }}>{PLAT_RATE[o]}%</div>
                        <div style={{ fontSize: 10, color: C.muted }}>수수료</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {sel.affiliateUrl && (
                <a href={sel.affiliateUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.violet, marginBottom: 16, wordBreak: "break-all" }}>저장된 링크: {sel.affiliateUrl} →</a>
              )}

              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 11 }}>구매 유도 문구</div>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 18 }}>
                {CTA_CHIPS.map((t) => {
                  const on = t === chosenCta;
                  return (
                    <button key={t} onClick={() => setCta((s) => ({ ...s, [sel.key]: t }))} style={{ ...ghostBtn, padding: "8px 13px", fontSize: 12, background: on ? C.ink : "#fff", color: on ? "#fff" : C.sub, border: on ? `1px solid ${C.ink}` : `1px solid ${C.line}` }}>{t}</button>
                  );
                })}
              </div>

              <div style={{ flex: 1, minHeight: 8 }} />
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => void c.saveCommerceLink(sel.clipId, sel.productId, platUrl(chosen, sel.brand, sel.product))} className="hv-soft" style={{ flex: 1, height: 46, ...ghostBtn, fontWeight: 700, fontSize: 13 }}>제휴 링크 저장</button>
                <button onClick={() => setDeployed((s) => ({ ...s, [sel.key]: true }))} className={isDeployed ? undefined : "hv-btn-primary"} style={{ flex: 2, height: 46, border: "none", borderRadius: 11, background: isDeployed ? C.greenSoft : C.violet, color: isDeployed ? C.green : "#fff", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
                  {isDeployed ? "배포 완료됨 ✓" : "커머스 콘텐츠 배포"}
                </button>
              </div>
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
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: "-.4px" }}>커머스 콘텐츠</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 5 }}>클립에서 AI가 인식한 브랜드를 외부 커머스에 연결합니다.</div>
        </div>
        <button onClick={() => setShowAnalyze((v) => !v)} className="hv-btn-primary" style={{ border: "none", background: C.violet, color: "#fff", fontSize: 12.5, fontWeight: 650, padding: "9px 14px", borderRadius: 9, cursor: "pointer" }}>{showAnalyze ? "분석 패널 닫기" : "클립 브랜드 분석"}</button>
      </div>

      {/* analyze panel */}
      {showAnalyze && (
        <div style={card({ padding: "16px 18px", marginBottom: 16 })}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>브랜드 분석할 클립</div>
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>Gemini 비전으로 클립 속 브랜드·제품을 인식합니다(클립당 수 초 소요).</div>
          {c.pickerClips.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.muted }}>먼저 스튜디오에서 쇼츠를 만들어 주세요.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto" }}>
              {c.pickerClips.map((pc) => {
                const analyzed = items.some((i) => i.clipId === pc.clipId);
                const busy = c.commerceAnalyzing === pc.clipId;
                return (
                  <div key={pc.clipId} className="hv-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 9px", borderRadius: 8 }}>
                    <span style={{ flex: 1, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pc.title}</span>
                    <span style={{ fontSize: 11, color: C.muted }}>{pc.project}</span>
                    {analyzed && <span style={{ fontSize: 10, color: C.green, fontWeight: 700 }}>분석됨</span>}
                    <button onClick={() => void c.analyzeClipForCommerce(pc)} disabled={busy} style={{ ...ghostBtn, padding: "5px 11px", fontSize: 11, opacity: busy ? 0.6 : 1 }}>{busy ? "분석 중…" : analyzed ? "재분석" : "분석"}</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 18 }}>
        <div style={card({ padding: "17px 18px" })}>
          <div style={{ fontSize: 11.5, color: C.body, fontWeight: 600 }}>인식된 상품</div>
          <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: "-1px", marginTop: 9 }}>{items.length}</div>
        </div>
        <div style={card({ padding: "17px 18px" })}>
          <div style={{ fontSize: 11.5, color: C.body, fontWeight: 600 }}>링크 연결됨</div>
          <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: "-1px", marginTop: 9 }}>{linkedCount}</div>
        </div>
        <div style={card({ padding: "17px 18px", background: "#F4F2FE", border: "1px solid #E4DEFB" })}>
          <div style={{ fontSize: 11.5, color: "#7C6FD6", fontWeight: 600 }}>예상 수익 합계 <span style={estimateBadge}>추정</span></div>
          <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: "-1px", marginTop: 9, color: C.ink }}>₩{fmtKor(revTotal)}</div>
        </div>
      </div>

      {/* product cards */}
      {c.commerceLoading && items.length === 0 ? (
        <div style={card({ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 })}>클립에서 인식된 브랜드를 불러오는 중…</div>
      ) : items.length === 0 ? (
        <div style={card({ padding: 40, textAlign: "center" })}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>아직 인식된 브랜드가 없어요</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 8, lineHeight: 1.6 }}>위의 &lsquo;클립 브랜드 분석&rsquo;에서 클립을 선택해 AI 브랜드 인식을 실행하세요.</div>
          <button onClick={() => setShowAnalyze(true)} className="hv-btn-primary" style={{ marginTop: 16, border: "none", background: C.violet, color: "#fff", fontSize: 13, fontWeight: 650, padding: "10px 18px", borderRadius: 9, cursor: "pointer" }}>브랜드 분석 시작</button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
          {items.map((it, index) => {
            const chosen = linkPlat[it.key] || recommendedPlatFor(it, index);
            const isDeployed = !!deployed[it.key];
            return (
              <div key={it.key} onClick={() => setSelectedKey(it.key)} className="hv-violet" style={card({ overflow: "hidden", display: "flex", flexDirection: "column", cursor: "pointer" })}>
                {(() => {
                  const thumb = thumbFor(it.clipId);
                  return (
                    <div style={{ position: "relative", height: 128, background: thumb ? C.ink : "repeating-linear-gradient(135deg,#F1F2F4,#F1F2F4 9px,#ECEEF2 9px,#ECEEF2 18px)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                      {thumb && <img src={thumb} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.85 }} />}
                      {!thumb && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 9, padding: "6px 10px" }}>
                          <div style={{ width: 22, height: 22, borderRadius: 6, background: C.violetSoft2, color: C.violet, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{it.brand.slice(0, 1)}</div>
                          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "-.2px" }}>{it.brand}</span>
                        </div>
                      )}
                      {thumb && (
                        <div style={{ position: "absolute", bottom: 8, left: 8, display: "flex", alignItems: "center", gap: 5, background: "rgba(0,0,0,.55)", backdropFilter: "blur(4px)", borderRadius: 7, padding: "4px 8px" }}>
                          <div style={{ width: 16, height: 16, borderRadius: 4, background: C.violet, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, color: "#fff" }}>{it.brand.slice(0, 1)}</div>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#fff" }}>{it.brand}</span>
                        </div>
                      )}
                      <span style={{ position: "absolute", top: 8, left: 8, fontSize: 9.5, fontWeight: 700, color: isDeployed ? C.green : it.affiliateUrl ? C.cyanInk : C.violet, background: isDeployed ? C.greenSoft : it.affiliateUrl ? C.cyanSoft : C.violetSoft, padding: "3px 8px", borderRadius: 5 }}>{isDeployed ? "배포 완료" : it.affiliateUrl ? "링크 연결됨" : "링크 대기"}</span>
                      <span style={{ position: "absolute", bottom: 8, right: 8, fontSize: 10.5, fontWeight: 700, color: "#fff", background: "rgba(16,18,24,.78)", padding: "2px 7px", borderRadius: 5, fontFeatureSettings: "'tnum' 1" }}>{it.exposure.toFixed(1)}초</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`'${it.brand} · ${it.product}' 커머스 항목을 삭제할까요?`)) void c.removeCommerceItem(it.key);
                        }}
                        title="삭제"
                        aria-label="커머스 항목 삭제"
                        style={{ position: "absolute", top: 8, right: 8, width: 24, height: 24, borderRadius: 7, border: "none", background: "rgba(16,18,24,.62)", color: "#fff", fontSize: 15, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
                      >×</button>
                    </div>
                  );
                })()}
                <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 650, letterSpacing: "-.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.product}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.projectTitle}{it.voiceMentions > 0 ? ` · 음성 ${it.voiceMentions}회` : ""}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 12 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: PLATFORM_META[chosen] || C.muted, padding: "3px 8px", borderRadius: 6 }}>{chosen}</span>
                    <span style={{ fontSize: 11.5, color: C.body }}>수수료 {PLAT_RATE[chosen]}%</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, color: C.faint }}>›</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 9, padding: "9px 11px" }}>
      <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 750, marginTop: 2, letterSpacing: "-.2px" }}>{value}</div>
    </div>
  );
}
