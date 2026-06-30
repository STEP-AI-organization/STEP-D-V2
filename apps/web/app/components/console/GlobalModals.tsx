"use client";

import { C, card, ghostBtn, input, label, primaryBtn } from "@/lib/console/theme";
import { PRIVACY_LABELS, type Privacy } from "@/lib/console/map";
import { useConsole } from "./ConsoleProvider";

const PRIVACIES: Privacy[] = ["public", "unlisted", "private"];

function Backdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 130, background: "rgba(16,18,24,.4)", display: "grid", placeItems: "center", padding: 24, animation: "scrimIn .18s ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ animation: "scPop .25s ease both" }}>
        {children}
      </div>
    </div>
  );
}

export function GlobalModals() {
  const c = useConsole();

  return (
    <>
      {/* ---------- publish draft ---------- */}
      {c.publishDraft && (
        <Backdrop onClose={() => c.setPublishDraft(null)}>
          <div style={card({ width: "min(540px,94vw)", padding: 24, maxHeight: "90vh", overflowY: "auto" })}>
            <div style={{ fontSize: 15, fontWeight: 750, marginBottom: 16 }}>{c.publishDraft.mode === "schedule" ? "유튜브 예약 발행" : "유튜브 발행"}</div>

            <label style={label}>채널</label>
            <select value={c.publishDraft.channelDbId} onChange={(e) => c.setPublishDraft(c.publishDraft ? { ...c.publishDraft, channelDbId: e.target.value } : null)} style={{ ...input, marginBottom: 14 }}>
              {c.channels.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.name}{ch.isDefault ? " (기본)" : ""}</option>
              ))}
            </select>

            <label style={label}>제목</label>
            <input value={c.publishDraft.title} onChange={(e) => c.setPublishDraft(c.publishDraft ? { ...c.publishDraft, title: e.target.value } : null)} style={{ ...input, marginBottom: 14 }} />

            <label style={label}>설명</label>
            <textarea value={c.publishDraft.description} onChange={(e) => c.setPublishDraft(c.publishDraft ? { ...c.publishDraft, description: e.target.value } : null)} rows={3} style={{ ...input, marginBottom: 14 }} />

            <label style={label}>태그 (쉼표로 구분)</label>
            <input value={c.publishDraft.tags} onChange={(e) => c.setPublishDraft(c.publishDraft ? { ...c.publishDraft, tags: e.target.value } : null)} style={{ ...input, marginBottom: 14 }} />

            <label style={label}>공개 범위</label>
            <div style={{ display: "flex", gap: 7, marginBottom: 14 }}>
              {PRIVACIES.map((p) => {
                const on = c.publishDraft!.privacy === p;
                return (
                  <button key={p} onClick={() => c.setPublishDraft(c.publishDraft ? { ...c.publishDraft, privacy: p } : null)} style={{ flex: 1, ...ghostBtn, padding: "8px 0", background: on ? C.violet : "#fff", color: on ? "#fff" : C.body, border: on ? `1px solid ${C.violet}` : `1px solid ${C.line}` }}>
                    {PRIVACY_LABELS[p]}
                  </button>
                );
              })}
            </div>

            {c.publishDraft.mode === "schedule" && (
              <>
                <label style={label}>예약 시간</label>
                <input type="datetime-local" value={c.publishDraft.scheduleLocal} onChange={(e) => c.setPublishDraft(c.publishDraft ? { ...c.publishDraft, scheduleLocal: e.target.value } : null)} style={{ ...input, marginBottom: 14 }} />
              </>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <button onClick={() => c.setPublishDraft(null)} style={{ flex: 1, ...ghostBtn, height: 44 }}>취소</button>
              <button onClick={c.doPublish} disabled={c.publishing} className="hv-btn-primary" style={{ flex: 2, ...primaryBtn, height: 44, opacity: c.publishing ? 0.6 : 1 }}>
                {c.publishing ? "처리 중…" : c.publishDraft.mode === "schedule" ? "예약 등록" : "지금 발행"}
              </button>
            </div>
          </div>
        </Backdrop>
      )}

      {/* ---------- channel connect review ---------- */}
      {c.channelDraftId && (
        <Backdrop onClose={c.closeChannelDraft}>
          <div style={card({ width: "min(520px,94vw)", padding: 24, maxHeight: "90vh", overflowY: "auto" })}>
            <div style={{ fontSize: 15, fontWeight: 750, marginBottom: 6 }}>연결할 YouTube 채널 선택</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 16 }}>{c.channelDraft?.google_account_email || ""}</div>
            {c.channelDraftLoading ? (
              <div style={{ padding: 30, textAlign: "center", color: C.muted, fontSize: 13 }}>채널을 불러오는 중…</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                {(c.channelDraft?.channels || []).map((ch) => {
                  const on = c.selectedDraftChannelIds.includes(ch.channel_id);
                  return (
                    <div key={ch.channel_id} onClick={() => c.toggleDraftChannel(ch.channel_id)} className="hv-violet" style={{ display: "flex", alignItems: "center", gap: 11, ...card({ padding: "11px 13px", cursor: "pointer", border: on ? `2px solid ${C.violet}` : `1px solid ${C.line}`, background: on ? "#FAF9FE" : "#fff" }) }}>
                      {ch.thumbnail_url ? (
                        <img src={ch.thumbnail_url} alt="" style={{ width: 34, height: 34, borderRadius: "50%" }} />
                      ) : (
                        <div style={{ width: 34, height: 34, borderRadius: "50%", background: C.violetSoft2, color: C.violet, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{ch.title.slice(0, 1)}</div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 650 }}>{ch.title}</div>
                        {ch.already_connected && <div style={{ fontSize: 11, color: C.muted }}>이미 연결됨 · 갱신</div>}
                      </div>
                      <span style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${on ? C.violet : C.line}`, background: on ? C.violet : "#fff", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{on ? "✓" : ""}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={c.closeChannelDraft} style={{ flex: 1, ...ghostBtn, height: 44 }}>취소</button>
              <button onClick={c.confirmChannelDraft} disabled={c.channelDraftSaving || c.selectedDraftChannelIds.length === 0} className="hv-btn-primary" style={{ flex: 2, ...primaryBtn, height: 44, opacity: c.channelDraftSaving || c.selectedDraftChannelIds.length === 0 ? 0.6 : 1 }}>
                {c.channelDraftSaving ? "연결 중…" : `${c.selectedDraftChannelIds.length}개 채널 연결`}
              </button>
            </div>
          </div>
        </Backdrop>
      )}

      {/* ---------- reschedule / cancel ---------- */}
      {c.schedAction && (
        <Backdrop onClose={() => c.setSchedAction(null)}>
          <div style={card({ width: "min(460px,94vw)", padding: 24 })}>
            <div style={{ fontSize: 15, fontWeight: 750, marginBottom: 4 }}>예약 변경</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.schedAction.item.title}</div>
            <label style={label}>새 예약 시간</label>
            <input type="datetime-local" value={c.schedAction.local} onChange={(e) => c.setSchedAction(c.schedAction ? { ...c.schedAction, local: e.target.value } : null)} style={{ ...input, marginBottom: 16 }} />
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={c.doCancelSched} disabled={c.schedBusy} style={{ flex: 1, ...ghostBtn, height: 44, color: C.danger, borderColor: "#F5C9C2" }}>예약 취소</button>
              <button onClick={c.doReschedule} disabled={c.schedBusy} className="hv-btn-primary" style={{ flex: 2, ...primaryBtn, height: 44, opacity: c.schedBusy ? 0.6 : 1 }}>{c.schedBusy ? "처리 중…" : "시간 변경"}</button>
            </div>
          </div>
        </Backdrop>
      )}

      {/* ---------- auto-distribute ---------- */}
      {c.autoDist && (
        <Backdrop onClose={() => c.setAutoDist(null)}>
          <div style={card({ width: "min(560px,94vw)", padding: 24, maxHeight: "90vh", overflowY: "auto" })}>
            <div style={{ fontSize: 15, fontWeight: 750, marginBottom: 16 }}>자동 배포 (여러 클립 예약)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <div>
                <label style={label}>채널</label>
                <select value={c.autoDist.channelDbId} onChange={(e) => c.setAutoDist(c.autoDist ? { ...c.autoDist, channelDbId: e.target.value } : null)} style={input}>
                  {c.channels.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
                </select>
              </div>
              <div>
                <label style={label}>시작 날짜</label>
                <input type="date" value={c.autoDist.startDate} onChange={(e) => c.setAutoDist(c.autoDist ? { ...c.autoDist, startDate: e.target.value } : null)} style={input} />
              </div>
            </div>
            <label style={label}>발행 시각 (쉼표로 여러 개)</label>
            <input value={c.autoDist.times} onChange={(e) => c.setAutoDist(c.autoDist ? { ...c.autoDist, times: e.target.value } : null)} placeholder="18:00, 21:00" style={{ ...input, marginBottom: 14 }} />
            <label style={label}>배포할 쇼츠 ({c.autoDist.selected.length}개 선택)</label>
            <div style={{ maxHeight: 220, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 10, padding: 6, marginBottom: 16 }}>
              {c.pickerClips.map((pc) => {
                const on = c.autoDist!.selected.includes(pc.clipId);
                return (
                  <div key={pc.clipId} onClick={() => c.toggleAutoClip(pc.clipId)} className="hv-row" style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 8px", borderRadius: 7, cursor: "pointer" }}>
                    <span style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${on ? C.violet : C.line}`, background: on ? C.violet : "#fff", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>{on ? "✓" : ""}</span>
                    <span style={{ flex: 1, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pc.title}</span>
                    <span style={{ fontSize: 11, color: C.muted }}>{pc.project}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => c.setAutoDist(null)} style={{ flex: 1, ...ghostBtn, height: 44 }}>취소</button>
              <button onClick={c.doAutoDistribute} disabled={c.autoDistBusy} className="hv-btn-primary" style={{ flex: 2, ...primaryBtn, height: 44, opacity: c.autoDistBusy ? 0.6 : 1 }}>{c.autoDistBusy ? "배치 중…" : "자동 배치"}</button>
            </div>
          </div>
        </Backdrop>
      )}
    </>
  );
}
