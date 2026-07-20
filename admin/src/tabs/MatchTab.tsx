import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteMatch,
  fetchMatchChannels,
  fetchMatchData,
  getToken,
  saveMatch,
  setToken,
} from "../api";
import type { LabChannel, LabMatchData, LabSourceMap } from "../types";
import { fmtLong, nfmt, parseTime } from "../util";

// ── YouTube IFrame API ───────────────────────────────────────────────────────
// The source longforms live on YouTube, not in our GCS, so the native <video> player the
// rest of the Lab uses can't scrub them. The IFrame API gives getCurrentTime()/seekTo(),
// which is all the range picker needs — and costs no download.

interface YTPlayer {
  getCurrentTime: () => number;
  seekTo: (s: number, allow: boolean) => void;
  destroy: () => void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApi: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (ytApi) return ytApi;
  ytApi = new Promise<void>((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return ytApi;
}

function YouTubeFrame({
  videoId,
  className,
  onPlayer,
}: {
  videoId: string;
  className?: string;
  onPlayer?: (p: YTPlayer | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cbRef = useRef(onPlayer);
  cbRef.current = onPlayer;

  useEffect(() => {
    let player: YTPlayer | null = null;
    let cancelled = false;
    void loadYouTubeApi().then(() => {
      if (cancelled || !hostRef.current || !window.YT) return;
      player = new window.YT.Player(hostRef.current, {
        videoId,
        playerVars: { enablejsapi: 1, rel: 0, modestbranding: 1 },
      });
      cbRef.current?.(player);
    });
    return () => {
      cancelled = true;
      cbRef.current?.(null);
      try {
        player?.destroy();
      } catch {
        /* already gone */
      }
    };
  }, [videoId]);

  // YT.Player REPLACES this node, so it must be a bare div it can swallow.
  return (
    <div className={className}>
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

// ── 매칭 화면 ────────────────────────────────────────────────────────────────
//
// 흐름: 채널 → 롱폼 하나 → 그 롱폼에서 나온 숏폼 여러 개 선택 → 숏폼마다 구간 지정.
// 롱폼을 한 번만 열어 두고 거기서 파생된 숏츠를 한 자리에서 처리한다. 구간은 숏폼마다
// 다르므로 선택만 다중이고 시작/끝은 행별로 따로 잡는다.

type Draft = { start: string; end: string; note: string };
const emptyDraft = (): Draft => ({ start: "", end: "", note: "" });

export default function MatchTab() {
  const [channels, setChannels] = useState<LabChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [data, setData] = useState<LabMatchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [longId, setLongId] = useState("");
  const [longQuery, setLongQuery] = useState("");
  const [shortQuery, setShortQuery] = useState("");
  const [showAllShorts, setShowAllShorts] = useState(false);
  const [picked, setPicked] = useState<Record<string, Draft>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [token, setTok] = useState(getToken());

  const longPlayer = useRef<YTPlayer | null>(null);

  useEffect(() => {
    fetchMatchChannels()
      .then((cs) => {
        setChannels(cs);
        setChannelId((cur) => cur || cs[0]?.channelId || "");
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  const reload = useCallback((id: string) => {
    if (!id) return;
    setLoading(true);
    fetchMatchData(id)
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLongId("");
    setPicked({});
    setData(null);
    reload(channelId);
  }, [channelId, reload]);

  const mapByShort = useMemo(() => {
    const m = new Map<string, LabSourceMap>();
    for (const x of data?.maps ?? []) m.set(x.shortVideoId, x);
    return m;
  }, [data]);

  /** How many shorts are already attributed to each longform (list badge). */
  const countByLong = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of data?.maps ?? []) m.set(x.longVideoId, (m.get(x.longVideoId) ?? 0) + 1);
    return m;
  }, [data]);

  const longs = useMemo(() => {
    const q = longQuery.trim().toLowerCase();
    return (data?.longs ?? [])
      .filter((l) => !q || l.title.toLowerCase().includes(q))
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  }, [data, longQuery]);

  const long = useMemo(
    () => (data?.longs ?? []).find((l) => l.videoId === longId) ?? null,
    [data, longId],
  );

  /** Candidates: a short can only come from a longform published no later than it. */
  const shorts = useMemo(() => {
    const all = data?.shorts ?? [];
    const q = shortQuery.trim().toLowerCase();
    const base = !long || showAllShorts
      ? all
      : all.filter((s) => Date.parse(s.publishedAt) >= Date.parse(long.publishedAt) - 24 * 3600 * 1000);
    return base
      .filter((s) => !q || s.title.toLowerCase().includes(q))
      .sort((a, b) => b.viewCount - a.viewCount);
  }, [data, long, showAllShorts, shortQuery]);

  // Opening a longform pre-selects the shorts already attributed to it.
  useEffect(() => {
    if (!longId) {
      setPicked({});
      return;
    }
    const pre: Record<string, Draft> = {};
    for (const m of data?.maps ?? []) {
      if (m.longVideoId !== longId) continue;
      pre[m.shortVideoId] = {
        start: String(Math.round(m.segStart)),
        end: String(Math.round(m.segEnd)),
        note: m.note ?? "",
      };
    }
    setPicked(pre);
    setMsg(null);
  }, [longId, data]);

  const toggle = (videoId: string) =>
    setPicked((p) => {
      if (p[videoId]) {
        const { [videoId]: _drop, ...rest } = p;
        return rest;
      }
      return { ...p, [videoId]: emptyDraft() };
    });

  const patch = (videoId: string, part: Partial<Draft>) =>
    setPicked((p) => ({ ...p, [videoId]: { ...(p[videoId] ?? emptyDraft()), ...part } }));

  const capture = (videoId: string, which: "start" | "end") => {
    const p = longPlayer.current;
    if (!p) {
      setMsg({ kind: "err", text: "롱폼 플레이어가 아직 준비되지 않았습니다." });
      return;
    }
    const t = String(Math.max(0, Math.round(p.getCurrentTime())));
    patch(videoId, which === "start" ? { start: t } : { end: t });
    setMsg(null);
  };

  const rowState = (d: Draft) => {
    const s = parseTime(d.start);
    const e = parseTime(d.end);
    const len = s != null && e != null ? e - s : null;
    return { s, e, len, ok: s != null && e != null && len != null && len > 0 && len <= 180 };
  };

  const pickedIds = Object.keys(picked);
  const validCount = pickedIds.filter((id) => rowState(picked[id]).ok).length;

  async function saveAll() {
    if (!long || !validCount) return;
    setSaving(true);
    let done = 0;
    const failed: string[] = [];
    for (const id of pickedIds) {
      const st = rowState(picked[id]);
      if (!st.ok || st.s == null || st.e == null) continue;
      try {
        await saveMatch({
          shortVideoId: id,
          channelId,
          longVideoId: long.videoId,
          segStart: st.s,
          segEnd: st.e,
          note: picked[id].note.trim() || undefined,
        });
        done++;
      } catch (e) {
        failed.push(`${id}: ${(e as Error).message}`);
      }
    }
    // Shorts that were attributed to this longform but are no longer checked → unlink.
    for (const m of data?.maps ?? []) {
      if (m.longVideoId === long.videoId && !picked[m.shortVideoId]) {
        await deleteMatch(m.shortVideoId).catch(() => {});
      }
    }
    setSaving(false);
    setMsg(
      failed.length
        ? { kind: "err", text: `${done}건 저장, ${failed.length}건 실패 — ${failed[0]}` }
        : { kind: "ok", text: `${done}건 저장했습니다.` },
    );
    reload(channelId);
  }

  const totalMapped = data?.maps.length ?? 0;

  return (
    <div>
      <div className="toolbar">
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {channels.map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.channelName}
              {c.subscribers ? ` (${nfmt(c.subscribers)})` : ""}
            </option>
          ))}
        </select>
        <span className="m-msg">
          이 채널 누적 매칭 <b className="m-picked">{totalMapped}</b>건
          {data ? ` · 롱폼 ${data.longs.length} · 숏폼 ${data.shorts.length}` : ""}
        </span>
        {!token && (
          <input
            placeholder="쓰기 토큰 입력"
            onBlur={(e) => {
              if (!e.target.value.trim()) return;
              setToken(e.target.value);
              setTok(getToken());
            }}
          />
        )}
      </div>

      {err && <div className="m-msg err" style={{ marginBottom: 10 }}>불러오기 실패: {err}</div>}
      {!token && (
        <div className="m-msg err" style={{ marginBottom: 10 }}>
          저장하려면 쓰기 토큰이 필요합니다 (서버 LAB_WRITE_TOKEN 값).
        </div>
      )}

      <div className="m-wrap">
        {/* 1단계: 롱폼 고르기 */}
        <div className="m-col">
          <div className="m-colhead">
            <b>① 롱폼</b>
            <input
              placeholder="롱폼 제목 검색"
              value={longQuery}
              onChange={(e) => setLongQuery(e.target.value)}
            />
          </div>
          {loading ? (
            <div className="empty-note">불러오는 중…</div>
          ) : !longs.length ? (
            <div className="empty-note">롱폼이 없습니다.</div>
          ) : (
            <div className="m-list">
              {longs.map((l) => {
                const n = countByLong.get(l.videoId) ?? 0;
                return (
                  <div
                    key={l.videoId}
                    className={`m-item${longId === l.videoId ? " on" : ""}`}
                    onClick={() => setLongId(l.videoId)}
                  >
                    {l.thumbnail && <img src={l.thumbnail} alt="" />}
                    <div className="b">
                      <div className="t">{l.title}</div>
                      <div className="s">
                        {l.publishedAt.slice(0, 10)} · {fmtLong(l.durationSec)} · 조회 {nfmt(l.viewCount)}
                        {n > 0 && <span className="done"> · 숏폼 {n}개</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 2단계: 그 롱폼에서 나온 숏폼들 + 구간 */}
        <div className="m-col">
          {!long ? (
            <div className="empty-note">
              왼쪽에서 롱폼을 고르면, 그 롱폼에서 나온 숏폼들을 여러 개 골라 각각 구간을 지정할 수 있습니다.
            </div>
          ) : (
            <div className="m-panel">
              <h3>{long.title}</h3>
              <YouTubeFrame
                key={long.videoId}
                videoId={long.videoId}
                className="m-long-fr"
                onPlayer={(p) => (longPlayer.current = p)}
              />

              <div className="m-colhead" style={{ marginTop: 14 }}>
                <b>② 이 롱폼에서 나온 숏폼 ({pickedIds.length}개 선택)</b>
                <input
                  placeholder="숏폼 제목 검색"
                  value={shortQuery}
                  onChange={(e) => setShortQuery(e.target.value)}
                />
                <button
                  className={showAllShorts ? "on" : ""}
                  onClick={() => setShowAllShorts((v) => !v)}
                >
                  {showAllShorts ? "전체 표시 중" : "이후 게시분만"}
                </button>
              </div>

              {/* 선택된 것들 — 숏폼마다 구간을 따로 잡는다 */}
              {pickedIds.length > 0 && (
                <div className="m-rows">
                  {pickedIds.map((id) => {
                    const s = (data?.shorts ?? []).find((x) => x.videoId === id);
                    const d = picked[id];
                    const st = rowState(d);
                    const other = mapByShort.get(id);
                    const stolen = other && other.longVideoId !== long.videoId;
                    return (
                      <div key={id} className={`m-row${st.ok ? " ok" : ""}`}>
                        <div className="m-row-h">
                          <span className="m-row-t">{s?.title ?? id}</span>
                          <span className="m-row-v">조회 {nfmt(s?.viewCount ?? 0)}</span>
                          <button className="cap ghost" onClick={() => toggle(id)}>
                            선택 해제
                          </button>
                        </div>
                        {stolen && (
                          <div className="m-msg err">
                            이 숏폼은 다른 롱폼에 매칭돼 있습니다 — 저장하면 이 롱폼으로 바뀝니다.
                          </div>
                        )}
                        <div className="m-range">
                          <button className="cap" onClick={() => capture(id, "start")}>
                            ⏱ 시작
                          </button>
                          <input
                            value={d.start}
                            onChange={(e) => patch(id, { start: e.target.value })}
                            placeholder="시작"
                          />
                          <button className="cap" onClick={() => capture(id, "end")}>
                            ⏱ 끝
                          </button>
                          <input
                            value={d.end}
                            onChange={(e) => patch(id, { end: e.target.value })}
                            placeholder="끝"
                          />
                          {st.s != null && (
                            <button
                              className="cap"
                              onClick={() => longPlayer.current?.seekTo(st.s!, true)}
                            >
                              ▶ 이동
                            </button>
                          )}
                          <input
                            style={{ width: 200, textAlign: "left" }}
                            placeholder="메모 (선택)"
                            value={d.note}
                            onChange={(e) => patch(id, { note: e.target.value })}
                          />
                          <span className={`len${st.len != null && !st.ok ? " bad" : ""}`}>
                            {st.len == null
                              ? "구간 미지정"
                              : st.ok
                                ? `${Math.round(st.len)}초 (${fmtLong(st.s!)} ~ ${fmtLong(st.e!)})`
                                : `${Math.round(st.len)}초 — 0 초과 180초 이하`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="m-actions">
                <button className="save" disabled={!validCount || saving || !token} onClick={saveAll}>
                  {saving ? "저장 중…" : `선택 ${validCount}건 저장`}
                </button>
                {msg && <span className={`m-msg ${msg.kind}`}>{msg.text}</span>}
              </div>

              {/* 후보 목록 — 체크하면 위 구간 편집기로 올라온다 */}
              <div className="m-cands">
                {shorts.map((s) => {
                  const on = !!picked[s.videoId];
                  const m = mapByShort.get(s.videoId);
                  const elsewhere = m && m.longVideoId !== long.videoId;
                  return (
                    <div
                      key={s.videoId}
                      className={`m-cand${on ? " on" : ""}`}
                      onClick={() => toggle(s.videoId)}
                    >
                      <input type="checkbox" checked={on} readOnly />
                      {s.thumbnail && <img src={s.thumbnail} alt="" />}
                      <div className="b">
                        <div className="t">{s.title}</div>
                        <div className="s">
                          조회 {nfmt(s.viewCount)} · {s.publishedAt.slice(0, 10)}
                          {m && !elsewhere && <span className="done"> · 이 롱폼</span>}
                          {elsewhere && <span className="warnq"> · 다른 롱폼</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="m-hint">
                롱폼을 재생하다가 ⏱ 시작/끝을 누르면 현재 위치가 들어갑니다. 초 또는 <code>m:ss</code>로 직접
                입력해도 되고, ±2~3초 오차는 규칙 학습에 문제되지 않습니다.
                <br />
                체크를 풀고 저장하면 이 롱폼과의 매칭이 해제됩니다. 잘된 숏폼만 모으지 마세요 — 성과가 갈린
                사례가 섞여야 무엇이 차이를 만들었는지 뽑을 수 있습니다.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
