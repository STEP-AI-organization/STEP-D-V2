"use client";

import { useState } from "react";
import { Download, Film, Pencil, Plus, Sparkles, Upload, Youtube } from "lucide-react";
import { clipDownloadUrl } from "@/lib/api";
import { C, POSTERS, card, ghostBtn, input, primaryBtn } from "@/lib/console/theme";
import { useConsole } from "../ConsoleProvider";

const STAGE_DEFS = [
  { name: "음성 전사", desc: "OpenAI STT로 전체 자막을 추출해요" },
  { name: "하이라이트 후보 추출", desc: "자막에서 터질 구간 20~30개를 골라요" },
  { name: "AI 장면 평가", desc: "Gemini가 상위 후보의 대표 프레임만 채점해요" },
  { name: "세로 쇼츠 렌더", desc: "9:16 캔버스에 자막·제목을 입혀 렌더해요" },
];

export function StudioScreen() {
  const c = useConsole();
  const [folder, setFolder] = useState<"all" | "upload" | "youtube">("all");

  const inEditor = (c.openProject || c.view === "results") && c.view !== "checking" && c.view !== "processing";

  /* ---------- subtitle question ---------- */
  if (c.view === "checking") {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 28px 60px" }}>
        <div style={card({ padding: "28px 30px" })}>
          <div style={{ fontSize: 17, fontWeight: 750, letterSpacing: "-.3px" }}>자막을 어떻게 처리할까요?</div>
          <div style={{ fontSize: 13, color: C.body, marginTop: 8, lineHeight: 1.6 }}>
            {c.fileName || "선택한 영상"} · 영상에 이미 화면 자막이 있다면 그대로 두고, 없다면 AI가 자동으로 자막을 만들어 입혀요.
            {c.inspection?.has_subtitle_stream ? " (내장 자막 트랙이 감지됐어요)" : ""}
          </div>
          {c.backendError && <div style={{ marginTop: 12, fontSize: 12.5, color: C.danger }}>{c.backendError}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
            <button onClick={() => c.answerSubs(true)} className="hv-card" style={{ flex: "1 1 220px", ...card({ padding: "16px 18px", textAlign: "left", cursor: "pointer", background: "#fff" }) }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>이미 자막이 있어요</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>자막 생성 없이 바로 컷·렌더</div>
            </button>
            <button onClick={() => c.answerSubs(false)} className="hv-btn-primary" style={{ flex: "1 1 220px", ...primaryBtn, padding: "16px 18px", textAlign: "left" }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>자막을 만들어 주세요</div>
              <div style={{ fontSize: 11.5, opacity: 0.85, marginTop: 4 }}>AI가 자동 자막을 입혀서 렌더</div>
            </button>
          </div>
          <button onClick={c.resetUpload} style={{ marginTop: 16, ...ghostBtn, padding: "8px 14px" }}>← 취소</button>
        </div>
      </div>
    );
  }

  /* ---------- processing ---------- */
  if (c.view === "processing") {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 28px 60px" }}>
        <div style={card({ padding: "30px 32px" })}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 18 }}>
            <Sparkles size={18} color={C.violet} />
            <div style={{ fontSize: 16, fontWeight: 750 }}>AI가 쇼츠를 만들고 있어요</div>
            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 20, fontWeight: 800, color: C.violet, fontFeatureSettings: "'tnum' 1" }}>{Math.round(c.progress)}%</div>
          </div>
          <div style={{ height: 8, background: C.lineSoft, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ width: `${c.progress}%`, height: "100%", background: C.violet, transition: "width .4s ease" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 22 }}>
            {STAGE_DEFS.map((s, i) => {
              const active = i === c.stageIndex;
              const done = i < c.stageIndex;
              return (
                <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 12, opacity: i <= c.stageIndex ? 1 : 0.4 }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", flex: "0 0 24px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: done || active ? "#fff" : C.muted, background: done ? C.green : active ? C.violet : C.lineSoft }}>
                    {done ? "✓" : i + 1}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 650, color: C.ink }}>{s.name}</div>
                    <div style={{ fontSize: 11.5, color: C.muted }}>{s.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
          {c.backendError && <div style={{ marginTop: 16, fontSize: 12.5, color: C.danger }}>{c.backendError}</div>}
        </div>
      </div>
    );
  }

  /* ---------- editor: clip grid for a project ---------- */
  if (inEditor) {
    const proj = c.projects.find((p) => p.id === c.openProject);
    return (
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "22px 28px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <button onClick={() => { c.resetUpload(); c.closeProject(); }} style={{ ...ghostBtn, padding: "7px 12px", fontSize: 12.5 }}>‹ 라이브러리</button>
          <div style={{ fontSize: 16, fontWeight: 750, letterSpacing: "-.3px" }}>{proj?.title || c.fileName || "방금 만든 쇼츠"}</div>
          <span style={{ fontSize: 11.5, color: C.muted }}>{c.activeClips.length}개 클립</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => c.setHighlightDraft({ title: `${(proj?.title || "하이라이트").replace(/\.[^.]+$/, "")} 하이라이트`.slice(0, 80), clipIds: c.activeClips.slice(0, 5).map((x) => x.id), aspect: "landscape", maxDurationSeconds: 720, result: null })}
            className="hv-soft"
            style={{ ...ghostBtn, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}
          >
            <Film size={14} /> 하이라이트 만들기
          </button>
        </div>

        {c.activeClips.length === 0 ? (
          <div style={card({ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 })}>클립을 불러오는 중이거나 아직 없습니다.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(230px,1fr))", gap: 14 }}>
            {c.activeClips.map((clip) => {
              const poster = POSTERS[(clip.rank - 1 + POSTERS.length) % POSTERS.length];
              const pub = c.publishState[clip.id];
              return (
                <div key={clip.id} style={card({ overflow: "hidden", display: "flex", flexDirection: "column" })}>
                  <div style={{ position: "relative", aspectRatio: "9 / 16", background: poster.g, overflow: "hidden" }}>
                    {clip.thumbnailUrl && <img src={clip.thumbnailUrl} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />}
                    <span style={{ position: "absolute", top: 8, right: 8, fontSize: 10.5, fontWeight: 700, color: "#fff", background: "rgba(16,18,24,.78)", padding: "2px 7px", borderRadius: 5, fontFeatureSettings: "'tnum' 1" }}>{clip.start}~{clip.end}</span>
                    <span style={{ position: "absolute", bottom: 8, left: 8, fontSize: 17, fontWeight: 800, color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,.5)" }}>{clip.score}</span>
                    {pub && <span style={{ position: "absolute", top: 8, left: 8, fontSize: 9.5, fontWeight: 700, color: "#fff", background: pub.status === "published" ? C.green : C.violet, padding: "2px 7px", borderRadius: 5 }}>{pub.status === "published" ? "발행됨" : pub.status === "scheduled" ? "예약됨" : "처리중"}</span>}
                  </div>
                  <div style={{ padding: "12px 13px", display: "flex", flexDirection: "column", flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 650, letterSpacing: "-.2px", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{clip.title}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 5, display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {clip.labels.slice(0, 2).map((l) => (
                        <span key={l} style={{ background: C.lineSoft, padding: "1px 6px", borderRadius: 4 }}>{l}</span>
                      ))}
                    </div>
                    <div style={{ flex: 1, minHeight: 10 }} />
                    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                      <button onClick={() => c.openClipEditor(clip.id)} className="hv-btn-primary" style={{ flex: 2, ...primaryBtn, height: 34, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                        <Pencil size={13} /> 편집
                      </button>
                      <button onClick={() => c.openPublishDraft(clip, "now")} className="hv-soft" style={{ flex: 1, ...ghostBtn, height: 34 }}>발행</button>
                      <a href={clipDownloadUrl(clip.id)} className="hv-soft" title="다운로드" style={{ ...ghostBtn, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Download size={14} />
                      </a>
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

  /* ---------- library ---------- */
  const filtered = c.projects.filter((p) => (folder === "all" ? true : folder === "youtube" ? !!p.ytId : !p.ytId));
  const folders: { key: "all" | "upload" | "youtube"; label: string; count: number }[] = [
    { key: "all", label: "전체", count: c.projects.length },
    { key: "upload", label: "업로드", count: c.projects.filter((p) => !p.ytId).length },
    { key: "youtube", label: "유튜브 임포트", count: c.projects.filter((p) => !!p.ytId).length },
  ];

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "22px 28px 60px" }}>
      {/* connected-sources strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 9, padding: "8px 12px" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green }} />
          <span style={{ fontSize: 12.5, fontWeight: 650, letterSpacing: "-.2px" }}>내 라이브러리</span>
          <span style={{ fontSize: 11, color: C.muted }}>프로젝트 {c.projects.length}개</span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: C.muted }}>긴 영상을 올리면 STT → 후보 → AI 평가 → 9:16 렌더로 쇼츠를 만들어요.</div>
      </div>

      {/* upload panel */}
      {c.uploadOpen && (
        <div style={card({ padding: "22px 24px", marginBottom: 18 })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 750 }}>새 콘텐츠</div>
            <button onClick={() => c.setUploadOpen(false)} style={{ ...ghostBtn, padding: "5px 11px", fontSize: 12 }}>닫기</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label
              onDragOver={(e) => { e.preventDefault(); c.setDragging(true); }}
              onDragLeave={() => c.setDragging(false)}
              onDrop={c.onDrop}
              style={{ border: `1.5px dashed ${c.dragging ? C.violet : C.line}`, borderRadius: 12, padding: "26px 18px", textAlign: "center", cursor: "pointer", background: c.dragging ? C.violetSoft : "#FBFBFC", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
            >
              <input type="file" accept="video/*" hidden onChange={c.onFileInput} />
              <Upload size={22} color={C.violet} />
              <div style={{ fontSize: 13, fontWeight: 650 }}>{c.selectedFile ? c.fileName : "MP4 파일을 끌어다 놓기"}</div>
              <div style={{ fontSize: 11.5, color: C.muted }}>{c.inspecting ? "영상 검사 중…" : "또는 클릭해서 선택"}</div>
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.body }}>유튜브 링크로 가져오기</div>
              <input value={c.ytUrl} onChange={(e) => c.setYtUrl(e.target.value)} placeholder="https://youtube.com/watch?v=…" style={input} />
              <button onClick={c.importYt} className="hv-soft" style={{ ...ghostBtn, padding: "9px 12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <Youtube size={15} color="#FF0000" /> 링크 준비
              </button>
              {c.ytPreviewId && <div style={{ fontSize: 11.5, color: C.green }}>링크 준비 완료 · {c.fileName}</div>}
            </div>
          </div>
          <button
            onClick={c.beginUpload}
            disabled={!c.selectedFile && !c.ytUrl.trim()}
            className="hv-btn-primary"
            style={{ ...primaryBtn, width: "100%", height: 44, marginTop: 16, opacity: !c.selectedFile && !c.ytUrl.trim() ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          >
            <Sparkles size={16} /> 쇼츠 만들기
          </button>
          {c.backendError && <div style={{ marginTop: 10, fontSize: 12.5, color: C.danger }}>{c.backendError}</div>}
        </div>
      )}

      {/* library: tree + grid */}
      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16, alignItems: "start" }}>
        <div style={card({ padding: "12px 10px", position: "sticky", top: 0 })}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, padding: "8px 8px 6px" }}>소스</div>
          {folders.map((f) => {
            const active = folder === f.key;
            return (
              <div key={f.key} onClick={() => setFolder(f.key)} className={active ? undefined : "hv-nav"} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 8, cursor: "pointer", background: active ? C.violetSoft : "transparent" }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: active ? 700 : 500, color: active ? C.ink : C.body, letterSpacing: "-.2px" }}>{f.label}</span>
                <span style={{ fontSize: 11, color: C.muted, fontFeatureSettings: "'tnum' 1" }}>{f.count}</span>
              </div>
            );
          })}
        </div>

        <div>
          <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, marginBottom: 12 }}>{c.studioLoaded ? `원본 ${filtered.length}개` : "불러오는 중…"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 14 }}>
            {/* new content card */}
            <button onClick={() => c.setUploadOpen(true)} className="hv-violet" style={{ ...card({ minHeight: 188, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", borderStyle: "dashed" }), color: C.violet }}>
              <Plus size={26} />
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>새 콘텐츠</div>
              <div style={{ fontSize: 11.5, color: C.muted }}>업로드 · 유튜브 링크</div>
            </button>

            {filtered.map((p) => {
              const poster = POSTERS[p.posterIdx % POSTERS.length];
              return (
                <div key={p.id} style={card({ overflow: "hidden", display: "flex", flexDirection: "column" })}>
                  <div style={{ position: "relative", height: 118, background: poster.g, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                    {p.thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.thumb} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(255,255,255,.18)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800 }}>{p.title.slice(0, 1)}</div>
                    )}
                    <span style={{ position: "absolute", top: 8, left: 8, fontSize: 9.5, fontWeight: 700, color: "#fff", background: "rgba(16,18,24,.55)", padding: "2px 7px", borderRadius: 5 }}>{p.ytId ? "YouTube" : "업로드"}</span>
                    {p.dur && <span style={{ position: "absolute", bottom: 8, right: 8, fontSize: 10.5, fontWeight: 700, color: "#fff", background: "rgba(16,18,24,.78)", padding: "2px 7px", borderRadius: 5 }}>{p.dur}</span>}
                  </div>
                  <div style={{ padding: "13px 14px", display: "flex", flexDirection: "column", flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 650, letterSpacing: "-.2px", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.title}</div>
                    <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>{p.status} · 클립 {p.shorts.length} · {p.date}</div>
                    <div style={{ flex: 1, minHeight: 10 }} />
                    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                      <button onClick={() => c.openProjectDetail(p.id)} className="hv-edit" style={{ flex: 1, ...ghostBtn, height: 36, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontWeight: 650 }}>
                        <Pencil size={13} /> 편집하기
                      </button>
                      <button onClick={() => c.handleDeleteProject(p.id)} className="hv-soft" title="삭제" style={{ ...ghostBtn, width: 36, height: 36, color: C.muted }}>✕</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* highlight render modal */}
      {c.highlightDraft && (
        <div onClick={() => c.setHighlightDraft(null)} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(16,18,24,.4)", display: "grid", placeItems: "center", padding: 24, animation: "scrimIn .18s ease" }}>
          <div onClick={(e) => e.stopPropagation()} style={card({ width: "min(520px,94vw)", padding: 24 })}>
            <div style={{ fontSize: 15, fontWeight: 750, marginBottom: 12 }}>하이라이트 MP4</div>
            <input value={c.highlightDraft.title} onChange={(e) => c.setHighlightDraft(c.highlightDraft ? { ...c.highlightDraft, title: e.target.value, result: null } : null)} style={input} />
            <div style={{ fontSize: 12, color: C.muted, margin: "12px 0 8px" }}>선택된 클립 {c.highlightDraft.clipIds.length}개로 가로 하이라이트를 만들어요.</div>
            {c.highlightDraft.result && (
              <a href={c.highlightDraft.result.video_url} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 12.5, color: C.violet, marginBottom: 10 }}>
                완성된 하이라이트 열기 →
              </a>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button onClick={() => c.setHighlightDraft(null)} style={{ flex: 1, ...ghostBtn, height: 42 }}>닫기</button>
              <button
                onClick={() => c.highlightDraft && c.doRenderHighlight(c.highlightDraft.clipIds, c.highlightDraft.title, c.highlightDraft.aspect, c.highlightDraft.maxDurationSeconds)}
                disabled={c.highlightBusy}
                className="hv-btn-primary"
                style={{ flex: 2, ...primaryBtn, height: 42, opacity: c.highlightBusy ? 0.6 : 1 }}
              >
                {c.highlightBusy ? "렌더링 중…" : "하이라이트 렌더"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
