import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  autoAlign,
  deleteMatch,
  fetchMatchChannels,
  fetchMatchData,
  getToken,
  saveMatch,
  setToken,
} from "../api";
import type { LabChannel, LabMatchData, LabSourceMap } from "../types";
import { fmtDur, fmtLong, nfmt, parseTime } from "../util";

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
  const [longSort, setLongSort] = useState<"date" | "views">("date");
  const [longTodoOnly, setLongTodoOnly] = useState(false);
  const [shortQuery, setShortQuery] = useState("");
  const [showAllShorts, setShowAllShorts] = useState(false);
  // 기본은 날짜순 — 조회순으로 두면 롱폼과 시기를 맞춰볼 수가 없다. 오름차순이라
  // "이후 게시분만"과 합쳐지면 롱폼 직후에 나온 숏폼이 맨 위로 온다(가장 유력한 후보).
  const [shortSort, setShortSort] = useState<"date" | "views">("date");
  const [picked, setPicked] = useState<Record<string, Draft>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [aligning, setAligning] = useState(false);
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
      .filter((l) => !longTodoOnly || !countByLong.has(l.videoId))
      .sort((a, b) =>
        longSort === "views"
          ? b.viewCount - a.viewCount
          : Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      );
  }, [data, longQuery, longSort, longTodoOnly, countByLong]);

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
      .sort((a, b) =>
        shortSort === "views"
          ? b.viewCount - a.viewCount
          : Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
      );
  }, [data, long, showAllShorts, shortQuery, shortSort]);

  /** 롱폼 게시일 대비 며칠 뒤 숏폼인지 — 같은 회차에서 나온 것끼리 묶어 보기 위한 단서. */
  const dayGap = useCallback(
    (publishedAt: string): number | null => {
      if (!long) return null;
      const d = (Date.parse(publishedAt) - Date.parse(long.publishedAt)) / 86_400_000;
      return Number.isFinite(d) ? Math.round(d) : null;
    },
    [long],
  );

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
        // 입력칸도 분:초로 — 롱폼은 60분이 넘어서 "2731"보다 "45:31"이 읽힌다.
        // parseTime이 m:ss·h:mm:ss·초를 모두 받으므로 손으로 초를 쳐도 그대로 동작한다.
        start: fmtLong(m.segStart),
        end: fmtLong(m.segEnd),
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
    const t = fmtLong(Math.max(0, Math.round(p.getCurrentTime())));
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

  /**
   * 선택한 숏폼들의 구간을 워커가 오디오 정렬로 찾게 한다. 롱폼 오디오를 받아 대조하므로
   * 수 분 걸린다 — 큐잉만 하고 결과는 주기적 재조회로 확인한다.
   */
  async function runAutoAlign() {
    if (!long || !pickedIds.length) return;
    const target = long.videoId;
    const ids = [...pickedIds];
    setAligning(true);
    setMsg({ kind: "ok", text: "구간 추적을 요청했습니다. 롱폼 오디오를 받아 대조하므로 몇 분 걸립니다…" });
    try {
      await autoAlign({ channelId, longVideoId: target, shortVideoIds: ids });
      // 워커가 한 건씩 채워 넣는다. 20초 간격으로 최대 5분 재조회.
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 20_000));
        const fresh = await fetchMatchData(channelId);
        setData(fresh);
        const filled = fresh.maps.filter(
          (m) => m.longVideoId === target && ids.includes(m.shortVideoId),
        );
        if (filled.length >= ids.length) {
          setMsg({ kind: "ok", text: `${filled.length}건 구간을 찾았습니다. 값을 확인하고 저장하세요.` });
          return;
        }
      }
      setMsg({ kind: "err", text: "아직 진행 중입니다 — 잠시 후 롱폼을 다시 열어 확인하세요." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setAligning(false);
    }
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
        {/* 토큰은 빌드에 주입돼 있다. 비어 있을 때만(=env 없이 빌드된 경우) 수동 입력을 노출. */}
        {!token && (
          <input
            placeholder="쓰기 토큰"
            onBlur={(e) => {
              if (!e.target.value.trim()) return;
              setToken(e.target.value);
              setTok(getToken());
            }}
          />
        )}
      </div>

      {err && <div className="m-msg err" style={{ marginBottom: 10 }}>불러오기 실패: {err}</div>}

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
          <div className="m-colhead">
            <button
              className={longSort === "date" ? "on" : ""}
              onClick={() => setLongSort("date")}
              title="최신 게시물부터"
            >
              최신순
            </button>
            <button
              className={longSort === "views" ? "on" : ""}
              onClick={() => setLongSort("views")}
            >
              조회순
            </button>
            <button
              className={longTodoOnly ? "on" : ""}
              onClick={() => setLongTodoOnly((v) => !v)}
              title="아직 숏폼을 하나도 매칭하지 않은 롱폼만"
            >
              미작업만
            </button>
            <span className="m-msg">{longs.length}편</span>
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
                  className={shortSort === "date" ? "on" : ""}
                  onClick={() => setShortSort("date")}
                  title="게시일 오름차순 — 롱폼 직후에 나온 숏폼이 위로"
                >
                  날짜순
                </button>
                <button
                  className={shortSort === "views" ? "on" : ""}
                  onClick={() => setShortSort("views")}
                >
                  조회순
                </button>
                <button
                  className={showAllShorts ? "on" : ""}
                  onClick={() => setShowAllShorts((v) => !v)}
                  title="끄면 롱폼 게시일 이후 숏폼만 표시"
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
                          {other?.source === "auto" && !other.confirmedAt && (
                            <span className="m-auto" title="오디오 정렬 자동 추정 — 값을 확인하고 저장하면 확정됩니다">
                              🎯 자동 추정{other.confidence ? ` ${other.confidence.toFixed(1)}x` : ""}
                            </span>
                          )}
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
                            placeholder="0:00"
                            title="분:초 (예 3:15). 초로 입력해도 됩니다."
                          />
                          <button className="cap" onClick={() => capture(id, "end")}>
                            ⏱ 끝
                          </button>
                          <input
                            value={d.end}
                            onChange={(e) => patch(id, { end: e.target.value })}
                            placeholder="0:00"
                            title="분:초 (예 4:03). 초로 입력해도 됩니다."
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
                                ? `${fmtLong(st.s!)} ~ ${fmtLong(st.e!)} · 길이 ${fmtDur(st.len)}`
                                : `길이 ${fmtDur(st.len)} — 0초 초과 3분 이하여야 합니다`}
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
                <button
                  className="cap"
                  disabled={!pickedIds.length || aligning || !token}
                  onClick={runAutoAlign}
                  title="선택한 숏폼의 오디오를 롱폼과 대조해 시작 지점을 자동으로 찾습니다"
                >
                  {aligning ? "추적 중… (수 분)" : `🎯 선택 ${pickedIds.length}건 구간 자동 추적`}
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
                          {s.publishedAt.slice(0, 10)}
                          {(() => {
                            const g = dayGap(s.publishedAt);
                            if (g == null) return null;
                            return (
                              <span className={g >= 0 && g <= 14 ? "near" : ""}>
                                {" "}
                                ({g === 0 ? "당일" : g > 0 ? `+${g}일` : `${g}일`})
                              </span>
                            );
                          })()}
                          {" · 조회 "}
                          {nfmt(s.viewCount)}
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
