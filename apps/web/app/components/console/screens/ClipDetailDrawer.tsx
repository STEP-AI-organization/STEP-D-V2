"use client";

import { useState } from "react";
import { Download, FileDown, Pencil, Send } from "lucide-react";
import { clipDownloadUrl, pplReportCsvUrl } from "@/lib/api";
import { C, card, ghostBtn, primaryBtn, segBtn, segWrap } from "@/lib/console/theme";
import { fmtCount, formatDuration } from "@/lib/console/format";
import { useConsole } from "../ConsoleProvider";
import { PplOverlayPlayer } from "../PplOverlayPlayer";

type Tab = "stats" | "silence" | "brand" | "title";
const SILENCE_LABEL: Record<string, { ko: string; color: string; bg: string }> = {
  dead_zone: { ko: "긴 무음", color: "#C0392B", bg: "#FDECEA" },
  pause: { ko: "쉼", color: "#B07A1E", bg: "#FDF4E3" },
  micro: { ko: "짧은 무음", color: C.muted, bg: C.lineSoft },
};

export function ClipDetailDrawer() {
  const c = useConsole();
  const [tab, setTab] = useState<Tab>("brand");
  const clip = c.activeClips.find((x) => x.id === c.selectedClipId) || null;
  const open = !!clip;
  const jobId = clip?.jobId || c.currentJobId || "";

  const close = () => c.setSelectedClipId(null);

  return (
    <>
      {open && <div onClick={close} style={{ position: "fixed", inset: 0, background: "rgba(16,18,24,0.32)", animation: "scrimIn .18s ease", zIndex: 55 }} />}
      <div style={{ position: "fixed", top: 0, right: 0, height: "100vh", width: 460, maxWidth: "94vw", background: "#fff", borderLeft: `1px solid ${C.line}`, boxShadow: "-12px 0 40px rgba(16,18,24,0.10)", zIndex: 56, transform: `translateX(${open ? "0%" : "100%"})`, transition: "transform .26s cubic-bezier(.4,0,.2,1)", display: "flex", flexDirection: "column" }}>
        {clip && (
          <>
            {/* header */}
            <div style={{ flex: "0 0 auto", padding: "18px 20px", borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <div style={{ width: 44, height: 44, borderRadius: 9, background: C.lineSoft, overflow: "hidden", flex: "0 0 44px" }}>
                  {clip.thumbnailUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={clip.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{clip.title}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{clip.start}~{clip.end} · 점수 {clip.score}</div>
                </div>
                <button onClick={close} className="hv-soft" style={{ width: 30, height: 30, ...ghostBtn, fontSize: 15, color: C.muted, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
              </div>
              <div style={{ display: "flex", gap: 7, marginTop: 14 }}>
                <button onClick={() => c.openClipEditor(clip.id)} className="hv-btn-primary" style={{ flex: 1, ...primaryBtn, height: 36, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><Pencil size={13} /> 편집</button>
                <button onClick={() => c.openPublishDraft(clip, "now")} className="hv-soft" style={{ flex: 1, ...ghostBtn, height: 36, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}><Send size={13} /> 발행</button>
                <a href={clipDownloadUrl(clip.id)} className="hv-soft" title="다운로드" style={{ ...ghostBtn, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center" }}><Download size={14} /></a>
              </div>
            </div>

            {/* tabs */}
            <div style={{ padding: "12px 16px 0" }}>
              <div style={segWrap}>
                {([["brand", "브랜드"], ["silence", "무음"], ["title", "제목"], ["stats", "성과"]] as [Tab, string][]).map(([k, l]) => (
                  <button key={k} onClick={() => setTab(k)} style={{ flex: 1, ...segBtn(tab === k) }}>{l}</button>
                ))}
              </div>
            </div>

            <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "16px 20px 30px" }}>
              {/* ---- BRAND (PPL) ---- */}
              {tab === "brand" && (() => {
                const ppl = c.pplData[clip.id] ?? clip.pplAnalysis;
                const busy = c.pplBusy === clip.id;
                return (
                  <div>
                    {ppl?.products?.length ? (
                      <>
                        <PplOverlayPlayer analysis={ppl} videoUrl={clip.videoUrl} poster={clip.thumbnailUrl} />
                        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                          {ppl.products.map((p) => (
                            <div key={p.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                                <span style={{ fontSize: 13, fontWeight: 700 }}>{p.brand}</span>
                                <span style={{ fontSize: 12, color: C.body }}>{p.product}</span>
                                <div style={{ flex: 1 }} />
                                <span style={{ fontSize: 11, color: C.muted }}>{Math.round(p.confidence * 100)}%</span>
                              </div>
                              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>노출 {p.exposure_seconds.toFixed(1)}초 · 음성 {(p.voice_mentions || []).length}회 · {p.category || "기타"}</div>
                            </div>
                          ))}
                        </div>
                        {jobId && (
                          <a href={pplReportCsvUrl(jobId)} className="hv-soft" style={{ ...ghostBtn, marginTop: 10, height: 36, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, textDecoration: "none", color: C.body, fontSize: 12.5 }}>
                            <FileDown size={13} /> 브랜드 리포트 CSV
                          </a>
                        )}
                      </>
                    ) : (
                      <div style={{ textAlign: "center", padding: "20px 0" }}>
                        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>아직 브랜드 분석을 하지 않았어요.</div>
                      </div>
                    )}
                    <button onClick={() => void c.runPpl(clip.id)} disabled={busy} className="hv-soft" style={{ ...ghostBtn, width: "100%", height: 40, marginTop: 14, opacity: busy ? 0.6 : 1 }}>{busy ? "분석 중…" : ppl?.products?.length ? "다시 분석" : "브랜드 분석 (AI)"}</button>
                  </div>
                );
              })()}

              {/* ---- SILENCE ---- */}
              {tab === "silence" && (() => {
                const rep = c.silenceReport[jobId];
                const busy = c.silenceBusy === jobId;
                return (
                  <div>
                    {rep ? (
                      <>
                        <div style={{ fontSize: 12.5, color: C.body, marginBottom: 12 }}>총 무음 {rep.total_silence_seconds.toFixed(1)}초 · {rep.segment_count}구간 (긴 무음 {rep.dead_zone_count} · 쉼 {rep.pause_count})</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {rep.segments.slice(0, 40).map((s, i) => {
                            const meta = SILENCE_LABEL[s.label] || SILENCE_LABEL.micro;
                            return (
                              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 11px", border: `1px solid ${C.line}`, borderRadius: 9 }}>
                                <span style={{ fontSize: 12, fontFeatureSettings: "'tnum' 1", color: C.ink, fontWeight: 600 }}>{formatDuration(s.start)} → {formatDuration(s.end)}</span>
                                <span style={{ fontSize: 11, color: C.muted }}>{s.duration.toFixed(1)}초</span>
                                <div style={{ flex: 1 }} />
                                <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, background: meta.bg, padding: "2px 7px", borderRadius: 5 }}>{meta.ko}</span>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12.5, color: C.muted, padding: "12px 0" }}>원본 영상의 무음 구간을 탐지해 편집 포인트를 제안합니다.</div>
                    )}
                    <button onClick={() => jobId && void c.loadSilenceReport(jobId)} disabled={busy || !jobId} className="hv-soft" style={{ ...ghostBtn, width: "100%", height: 40, marginTop: 14, opacity: busy || !jobId ? 0.6 : 1 }}>{busy ? "탐지 중…" : "무음 구간 탐지"}</button>
                  </div>
                );
              })()}

              {/* ---- TITLE / THUMBNAIL ---- */}
              {tab === "title" && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>제목 후보</span>
                    <button onClick={() => void c.regenTitles(clip.id)} disabled={c.titleBusy} style={{ ...ghostBtn, padding: "5px 11px", fontSize: 11, opacity: c.titleBusy ? 0.6 : 1 }}>{c.titleBusy ? "생성 중…" : "재생성"}</button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 18 }}>
                    {clip.titleOptions.map((o) => (
                      <div key={o.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px" }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{o.text}</div>
                        {o.note && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{o.note}</div>}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>썸네일 문구</span>
                    <button onClick={() => void c.regenThumbs(clip.id)} disabled={c.thumbBusy} style={{ ...ghostBtn, padding: "5px 11px", fontSize: 11, opacity: c.thumbBusy ? 0.6 : 1 }}>{c.thumbBusy ? "생성 중…" : "재생성"}</button>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {clip.thumbTextOptions.length === 0 ? (
                      <span style={{ fontSize: 12, color: C.muted }}>아직 썸네일 문구가 없어요. 재생성을 눌러보세요.</span>
                    ) : (
                      clip.thumbTextOptions.map((o) => (
                        <span key={o.id} style={{ fontSize: 12, fontWeight: 600, color: C.sub, background: C.lineSoft, padding: "6px 11px", borderRadius: 8 }}>{o.text}</span>
                      ))
                    )}
                  </div>
                  <div style={{ fontSize: 10.5, color: C.faint, marginTop: 16, lineHeight: 1.5 }}>제목·문구 적용은 &lsquo;편집&rsquo;에서 미리보기와 함께 반영돼요.</div>
                </div>
              )}

              {/* ---- STATS ---- */}
              {tab === "stats" && (() => {
                const st = c.clipYtStats[clip.id];
                const busy = c.clipStatsBusy === clip.id;
                return (
                  <div>
                    {st?.published && st.stats ? (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                        <StatCard label="조회수" value={fmtCount(st.stats.view_count)} />
                        <StatCard label="좋아요" value={fmtCount(st.stats.like_count)} />
                        <StatCard label="댓글" value={fmtCount(st.stats.comment_count)} />
                      </div>
                    ) : st && !st.published ? (
                      <div style={{ fontSize: 12.5, color: C.muted, padding: "12px 0" }}>아직 유튜브에 발행되지 않았어요. 발행 후 실시간 성과가 표시됩니다.</div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: C.muted, padding: "12px 0" }}>발행된 클립의 실시간 조회수·좋아요·댓글을 불러옵니다.</div>
                    )}
                    {st?.published && st.youtube_url && (
                      <a href={st.youtube_url} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 12, color: C.violet, marginTop: 12 }}>유튜브에서 열기 →</a>
                    )}
                    <button onClick={() => void c.loadClipYtStats(clip.id)} disabled={busy} className="hv-soft" style={{ ...ghostBtn, width: "100%", height: 40, marginTop: 14, opacity: busy ? 0.6 : 1 }}>{busy ? "불러오는 중…" : "성과 불러오기"}</button>
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={card({ padding: "14px 12px", textAlign: "center" })}>
      <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: "-.5px" }}>{value}</div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{label}</div>
    </div>
  );
}
