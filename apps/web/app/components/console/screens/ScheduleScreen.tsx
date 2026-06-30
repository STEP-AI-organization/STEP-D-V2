"use client";

import { useMemo, useState } from "react";
import { C, card, ghostBtn, primaryBtn, segBtn, segWrap } from "@/lib/console/theme";
import type { SchedItem } from "@/lib/console/map";
import { DUMMY_SCHED } from "@/lib/console/dummy";
import { useConsole } from "../ConsoleProvider";

const WEEKDAYS = [
  { l: "일", c: "#E5484D" },
  { l: "월", c: C.muted },
  { l: "화", c: C.muted },
  { l: "수", c: C.muted },
  { l: "목", c: C.muted },
  { l: "금", c: C.muted },
  { l: "토", c: "#2A6FD8" },
];

export function ScheduleScreen() {
  const c = useConsole();
  const [monthOffset, setMonthOffset] = useState(0);
  const [tab, setTab] = useState<"status" | "manage">("status");

  // 데모 기준일: 2026-07-01 (내일 발표) — 항상 7월에 열리고 7/1이 오늘·선택일이 되도록 고정
  const now = new Date(2026, 6, 1);
  const base = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const Y = base.getFullYear();
  const M = base.getMonth();
  const firstDow = base.getDay();
  const dim = new Date(Y, M + 1, 0).getDate();
  const todayNum = now.getMonth() === M && now.getFullYear() === Y ? now.getDate() : -1;

  const [selectedDay, setSelectedDay] = useState<number>(now.getDate());

  const allSched = useMemo(() => {
    if (c.sched.length > 0) return c.sched;
    return DUMMY_SCHED;
  }, [c.sched]);

  const byDay = useMemo(() => {
    const map: Record<number, SchedItem[]> = {};
    allSched.filter((it) => it.year === Y && it.month === M).forEach((it) => {
      (map[it.day] = map[it.day] || []).push(it);
    });
    return map;
  }, [allSched, Y, M]);

  type Cell = { day: number | null };
  const cells: Cell[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: null });
  for (let d = 1; d <= dim; d++) cells.push({ day: d });
  while (cells.length % 7 !== 0) cells.push({ day: null });

  const dayItems = byDay[selectedDay] || [];
  const upcoming = allSched.filter((it) => it.status === "예약");

  return (
    <div style={{ maxWidth: 1320, margin: "0 auto", padding: "22px 28px 60px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 18, alignItems: "start" }}>
        {/* calendar */}
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: "-.4px" }}>배포 스케줄</div>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <button onClick={() => setMonthOffset((m) => m - 1)} className="hv-soft" style={{ width: 30, height: 30, ...ghostBtn, fontSize: 13 }}>‹</button>
              <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-.2px" }}>{Y}년 {M + 1}월</span>
              <button onClick={() => setMonthOffset((m) => m + 1)} className="hv-soft" style={{ width: 30, height: 30, ...ghostBtn, fontSize: 13 }}>›</button>
            </div>
          </div>
          <div style={card({ overflow: "hidden" })}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", borderBottom: `1px solid ${C.lineSoft}` }}>
              {WEEKDAYS.map((w) => (
                <div key={w.l} style={{ textAlign: "center", fontSize: 11.5, fontWeight: 600, color: w.c, padding: "10px 0" }}>{w.l}</div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)" }}>
              {cells.map((cell, i) => {
                if (cell.day === null) return <div key={i} style={{ minHeight: 110, borderRight: `1px solid ${C.lineSoft}`, borderBottom: `1px solid ${C.lineSoft}`, background: "#FBFBFC" }} />;
                const items = byDay[cell.day] || [];
                const isToday = cell.day === todayNum;
                const isSel = cell.day === selectedDay;
                return (
                  <div
                    key={i}
                    onClick={() => setSelectedDay(cell.day!)}
                    className="hv-row"
                    style={{ minHeight: 110, borderRight: `1px solid ${C.lineSoft}`, borderBottom: `1px solid ${C.lineSoft}`, border: isSel ? `1.5px solid ${C.violet}` : undefined, background: isToday ? "#FFF8F2" : "#fff", padding: "7px 7px 8px", cursor: "pointer", overflow: "hidden" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: isToday ? C.violet : C.ink, fontFeatureSettings: "'tnum' 1" }}>{cell.day}</span>
                      {items.length > 0 && <span style={{ fontSize: 9.5, color: C.faint, fontWeight: 600 }}>{items.length}건</span>}
                    </div>
                    {items.slice(0, 3).map((it) => {
                      const green = it.status === "발행";
                      return (
                        <div key={it.publishId} onClick={(e) => { e.stopPropagation(); c.openReschedule(it); }} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3 }}>
                          <span style={{ fontSize: 8, fontWeight: 800, color: "#fff", background: green ? C.green : C.violet, padding: "1px 4px", borderRadius: 3, flex: "0 0 auto", lineHeight: 1.3 }}>{it.status}</span>
                          <span style={{ fontSize: 10, color: C.body, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</span>
                        </div>
                      );
                    })}
                    {items.length > 3 && <div style={{ fontSize: 9.5, color: C.muted, fontWeight: 600, marginTop: 2 }}>+{items.length - 3}건</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* right panel */}
        <div style={card({ overflow: "hidden", position: "sticky", top: 0 })}>
          <div style={{ display: "flex", gap: 3, background: C.lineSoft, padding: 4, margin: "14px 14px 0", borderRadius: 9 }}>
            <button onClick={() => setTab("status")} style={{ flex: 1, ...segBtn(tab === "status"), padding: "7px 0" }}>배포 현황</button>
            <button onClick={() => setTab("manage")} style={{ flex: 1, ...segBtn(tab === "manage"), padding: "7px 0" }}>스케줄 관리</button>
          </div>

          {tab === "status" ? (
            <>
              <div style={{ padding: "16px 16px 8px" }}>
                <div style={{ fontSize: 14, fontWeight: 750, letterSpacing: "-.3px" }}>{M + 1}월 {selectedDay}일</div>
              </div>
              <div style={{ padding: "0 16px 18px", maxHeight: 560, overflowY: "auto" }}>
                {dayItems.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: C.muted, padding: "20px 0" }}>이 날짜에 예약된 배포가 없어요.</div>
                ) : (
                  dayItems.map((it) => (
                    <div key={it.publishId} onClick={() => c.openReschedule(it)} className="hv-row" style={{ display: "flex", gap: 11, padding: "11px 6px", borderBottom: `1px solid ${C.lineSoft}`, cursor: "pointer", borderRadius: 7 }}>
                      <div style={{ flex: "0 0 42px", fontSize: 11.5, fontWeight: 700, color: C.ink, fontFeatureSettings: "'tnum' 1", paddingTop: 1 }}>{it.time}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: it.status === "발행" ? C.green : C.violet, fontWeight: 600 }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: it.status === "발행" ? C.green : C.violet }} />{it.status}
                        </span>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, marginTop: 5, letterSpacing: "-.2px", lineHeight: 1.4 }}>{it.title}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div style={{ padding: "16px 16px 18px" }}>
              <button onClick={c.openAutoDist} className="hv-btn-primary" style={{ ...primaryBtn, width: "100%", height: 42, marginBottom: 16 }}>자동 배포 예약</button>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.body, marginBottom: 10 }}>예약된 배포 {upcoming.length}건</div>
              <div style={{ maxHeight: 520, overflowY: "auto" }}>
                {upcoming.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: C.muted, padding: "16px 0" }}>예약된 배포가 없어요. 자동 배포로 한 번에 예약해 보세요.</div>
                ) : (
                  upcoming.map((it) => (
                    <div key={it.publishId} onClick={() => c.openReschedule(it)} className="hv-row" style={{ padding: "11px 6px", borderBottom: `1px solid ${C.lineSoft}`, cursor: "pointer", borderRadius: 7 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{it.year}.{String(it.month + 1).padStart(2, "0")}.{String(it.day).padStart(2, "0")} {it.time}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
