import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchLearnedProfile,
  fetchMatchExport,
  fetchMatchStatus,
  fetchOverview,
  getToken,
  runBulk,
  runBulkAll,
  runLearn,
  runSegment,
  type LearnedProfile,
  type LearnPair,
  type MatchStatus,
  type OverviewChannel,
} from "../api";
import { fmtDur, fmtLong, nfmt } from "../util";

/**
 * 매칭 작업의 산출물을 보는 화면.
 *
 * 위: 전 채널 현황 — 어디를 더 돌려야 하는지와 채널별 일괄 실행 버튼.
 * 아래: LEARN 데이터셋 — 매칭된 쌍과 연령보정 성과 티어. 학습에 넣기 전에 사람이
 * "이 데이터가 쓸 만한가"를 눈으로 확인하는 자리다. 티어가 한쪽으로 쏠려 있으면
 * (예: high만 잔뜩) 무엇이 차이를 만드는지 배울 수 없으므로 분포를 먼저 보여준다.
 */
export default function DatasetTab() {
  const [rows, setRows] = useState<OverviewChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [pairs, setPairs] = useState<LearnPair[]>([]);
  const [tally, setTally] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [status, setStatus] = useState<MatchStatus | null>(null);
  const [learned, setLearned] = useState<LearnedProfile | null>(null);
  const token = getToken();

  // 선택 채널의 단계별 진행(매칭·설명·잡) + 학습된 규칙을 주기적으로 갱신.
  const refreshChannel = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const [s, p] = await Promise.all([fetchMatchStatus(id), fetchLearnedProfile(id)]);
      setStatus(s);
      setLearned(p.profile);
    } catch {
      /* 부가 정보 — 실패해도 화면을 막지 않는다 */
    }
  }, []);

  useEffect(() => {
    void refreshChannel(channelId);
    const t = window.setInterval(() => void refreshChannel(channelId), 20_000);
    return () => window.clearInterval(t);
  }, [channelId, refreshChannel]);

  const loadOverview = useCallback(async () => {
    try {
      const r = await fetchOverview();
      setRows(r);
      setChannelId((cur) => cur || r.find((x) => x.matched > 0)?.channelId || r[0]?.channelId || "");
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    const t = window.setInterval(() => void loadOverview(), 30_000);
    return () => window.clearInterval(t);
  }, [loadOverview]);

  useEffect(() => {
    if (!channelId) return;
    setLoading(true);
    fetchMatchExport(channelId)
      .then((r) => {
        setPairs(r.pairs);
        setTally(r.tally);
      })
      .catch((e: Error) => setMsg({ kind: "err", text: e.message }))
      .finally(() => setLoading(false));
  }, [channelId]);

  const totals = useMemo(() => {
    const t = { shorts: 0, matched: 0, auto: 0, remaining: 0, pending: 0, running: 0 };
    for (const r of rows) {
      t.shorts += r.shorts;
      t.matched += r.matched;
      t.auto += r.auto;
      t.remaining += r.remaining;
      t.pending += r.jobs.pending ?? 0;
      t.running += r.jobs.running ?? 0;
    }
    return t;
  }, [rows]);

  async function bulkOne(id: string) {
    setBusy(true);
    try {
      const r = await runBulk(id, 300);
      setMsg({ kind: "ok", text: `${r.queued}편 큐잉 (숏폼 ${r.shorts}개) · 예상 ${r.etaMinutes}분` });
      void loadOverview();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function bulkAll() {
    if (!window.confirm("연동된 모든 채널에 자동 매칭을 겁니다. 진행할까요?")) return;
    setBusy(true);
    try {
      const r = await runBulkAll(300);
      setMsg({ kind: "ok", text: `채널 ${r.channels}곳 · ${r.queued}편 큐잉 · 예상 ${Math.round(r.etaMinutes / 60)}시간` });
      void loadOverview();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function fillSegments() {
    setBusy(true);
    try {
      const r = await runSegment(channelId);
      setMsg({
        kind: "ok",
        text: r.missing === 0 ? "채울 구간이 없습니다 (이미 완료)" : `구간 설명 시작 — 미설명 ${r.missing}건 (롱폼 ${r.longforms ?? "?"}편)`,
      });
      void refreshChannel(channelId);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function learnRules() {
    setBusy(true);
    try {
      await runLearn(channelId);
      setMsg({
        kind: "ok",
        text: "규칙 학습을 요청했습니다. 미설명 구간이 있으면 먼저 자동으로 채운 뒤 학습합니다 (몇 분~수십 분).",
      });
      void refreshChannel(channelId);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify({ channelId, tally, pairs }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `learn-dataset-${channelId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const total = (tally.high ?? 0) + (tally.mid ?? 0) + (tally.low ?? 0);
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  return (
    <div>
      {/* ── 안내 배너 ─────────────────────────────────────────────────── */}
      <div className="d-intro">
        <b>채널마다 "잘 터지는 규칙"을 학습합니다.</b> 채널을 고르면 아래에 진행 상황과 다음 할 일이
        나옵니다. ① 숏폼↔롱폼 매칭 → ② 구간 설명 → ③ 규칙 학습, 순서대로 버튼만 누르면 됩니다.
      </div>

      {/* ── 전 채널 현황 ─────────────────────────────────────────────── */}
      <div className="d-head">
        <b>채널 목록 <span className="dim" style={{ fontWeight: 400 }}>(행을 클릭해 선택)</span></b>
        <span className="m-msg">
          전체 매칭 <b className="m-picked">{nfmt(totals.matched)}</b>건 · 남은 숏폼 {nfmt(totals.remaining)}
          {totals.pending + totals.running > 0 && (
            <> · 작업중 {totals.running} / 대기 {totals.pending}</>
          )}
        </span>
        <button onClick={bulkAll} disabled={busy || !token} title="연동된 모든 채널을 한 번에 매칭">
          ⚡ 전 채널 한 번에 매칭
        </button>
      </div>

      <div className="d-table">
        <div className="d-tr d-th">
          <span>채널</span><span>롱폼</span><span>숏폼</span><span>매칭</span>
          <span>미확인</span><span>남음</span><span>잡</span><span></span>
        </div>
        {rows.map((r) => (
          <div
            key={r.channelId}
            className={`d-tr${channelId === r.channelId ? " on" : ""}`}
            onClick={() => setChannelId(r.channelId)}
          >
            <span className="d-name">{r.channelName}</span>
            <span>{nfmt(r.longs)}</span>
            <span>{nfmt(r.shorts)}</span>
            <span className={r.matched ? "good" : ""}>{nfmt(r.matched)}</span>
            <span className={r.auto ? "warn" : ""}>{r.auto || "—"}</span>
            <span>{nfmt(r.remaining)}</span>
            <span>
              {r.jobs.running ? `▶${r.jobs.running} ` : ""}
              {r.jobs.pending ? `⏳${r.jobs.pending}` : ""}
              {!r.jobs.running && !r.jobs.pending ? "—" : ""}
            </span>
            <span>
              <button
                className="cap"
                disabled={busy || !token || r.remaining === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  void bulkOne(r.channelId);
                }}
              >
                ⚡ 실행
              </button>
            </span>
          </div>
        ))}
      </div>

      {msg && <div className={`m-msg ${msg.kind}`} style={{ margin: "10px 0" }}>{msg.text}</div>}

      {/* ── 학습 파이프라인 (선택 채널) ────────────────────────────────── */}
      {channelId && (() => {
        const selName = rows.find((r) => r.channelId === channelId)?.channelName ?? channelId;
        const matched = status?.matched ?? 0;
        const described = status?.described ?? 0;
        const jobs = status?.jobs;
        const busyJobs = (jobs?.pending ?? 0) + (jobs?.running ?? 0) > 0;
        const step = (n: number, label: string, doneCount: number, totalCount: number, active: boolean) => {
          const done = totalCount > 0 && doneCount >= totalCount;
          return (
            <div className={`lp-step${done ? " done" : active ? " active" : ""}`}>
              <span className="lp-num">{done ? "✓" : n}</span>
              <div className="lp-body">
                <div className="lp-label">{label}</div>
                <div className="lp-sub">{totalCount > 0 ? `${doneCount} / ${totalCount}` : "—"}</div>
              </div>
            </div>
          );
        };
        const remaining = rows.find((r) => r.channelId === channelId)?.remaining ?? 0;
        // "다음 할 일"을 하나로 안내 — 사용자가 순서를 고민하지 않게.
        type Next = { title: string; desc: string; cta: string; run: () => void; disabled?: boolean; tone?: "go" | "wait" };
        let next: Next;
        if (busyJobs) {
          next = {
            title: "작업이 돌아가고 있어요",
            desc: `워커가 처리 중입니다 (실행 ${jobs?.running ?? 0} · 대기 ${jobs?.pending ?? 0}). 20초마다 자동 새로고침되니 기다리시면 됩니다.`,
            cta: "새로고침", run: () => refreshChannel(channelId), tone: "wait",
          };
        } else if (matched === 0) {
          next = {
            title: "1단계 — 숏폼을 롱폼에 매칭하세요",
            desc: `이 채널의 숏폼 ${remaining}개가 어느 롱폼 구간에서 나왔는지 자동으로 찾습니다.`,
            cta: "⚡ 매칭 시작", run: () => bulkOne(channelId),
          };
        } else if (described < matched) {
          next = {
            title: "2단계 — 매칭 구간을 설명하세요",
            desc: `${matched}건 중 ${described}건 완료. 남은 ${matched - described}건의 자막·장면을 채워야 규칙을 배울 수 있어요.`,
            cta: `✍️ 나머지 ${matched - described}건 설명`, run: fillSegments,
          };
        } else if (!learned?.ready) {
          next = {
            title: "3단계 — 규칙을 학습하세요",
            desc: "매칭·설명이 다 됐습니다. 이제 고성과 규칙을 뽑아 이 채널의 추천에 반영합니다.",
            cta: "🧠 규칙 학습 실행", run: learnRules,
          };
        } else {
          next = {
            title: "학습 완료 — 데이터가 쌓이면 더 정확해져요",
            desc: "규칙이 저장돼 이 채널 영상 분석에 자동 반영됩니다. 매칭을 더 늘리고 다시 학습하면 정확도가 올라갑니다.",
            cta: "🔄 규칙 다시 학습", run: learnRules, tone: "wait",
          };
        }

        return (
          <div style={{ marginTop: 22 }}>
            <div className="d-head">
              <b>🧠 {selName} 학습 진행</b>
              {jobs?.failed ? <span className="m-msg err">· 실패 {jobs.failed}건 (레이트리밋일 수 있어요)</span> : null}
            </div>

            {/* 다음 할 일 배너 — 지금 뭘 눌러야 하는지 하나로 */}
            <div className={`d-next ${next.tone ?? "go"}`}>
              <div className="d-next-body">
                <div className="d-next-title">{next.title}</div>
                <div className="d-next-desc">{next.desc}</div>
              </div>
              <button className="d-next-cta" disabled={busy || !token || next.disabled}
                onClick={next.run}>
                {busy ? "처리 중…" : next.cta}
              </button>
            </div>
            {!token && <div className="m-msg err" style={{ marginBottom: 8 }}>실행하려면 쓰기 토큰이 필요합니다.</div>}

            <div className="lp-steps">
              {step(1, "① 매칭", matched, matched || 1, busyJobs)}
              {step(2, "② 구간 설명", described, matched, described < matched && busyJobs)}
              {step(3, "③ 규칙 학습", learned?.ready ? 1 : 0, 1, false)}
            </div>

            {/* 세부 조작은 접어둠 — 평소엔 위 배너 하나로 충분 */}
            <details className="d-more">
              <summary>단계별로 직접 실행 / 다시 하기</summary>
              <div className="m-actions" style={{ marginTop: 8 }}>
                <button className="cap" disabled={busy || !token}
                  onClick={() => bulkOne(channelId)}>⚡ 매칭 채우기</button>
                <button className="cap" disabled={busy || !token || described >= matched}
                  onClick={fillSegments}>✍️ 설명 채우기 ({Math.max(0, matched - described)} 남음)</button>
                <button className="cap" disabled={busy || !token || matched === 0}
                  onClick={learnRules}>🧠 규칙 학습</button>
              </div>
            </details>

            {/* 학습된 규칙 카드 */}
            {learned?.ready ? (
              <div className="lp-profile">
                <div className="lp-phead">
                  <b>📋 이 채널에서 배운 규칙</b>
                  <span className={`lp-conf ${(learned.confidence ?? 0) >= 0.7 ? "hi" : "mid"}`}>
                    신뢰도 {Math.round((learned.confidence ?? 0) * 100)}%
                  </span>
                  {learned.sample && (
                    <span className="m-msg">잘된 숏폼 {learned.sample.high}개 vs 아쉬운 것 {learned.sample.low}개로 학습</span>
                  )}
                  {(learned.confidence ?? 0) < 0.7 && (
                    <span className="m-msg warn">· 매칭을 더 늘려 다시 학습하면 정확해져요</span>
                  )}
                </div>
                <div className="lp-cols">
                  <div>
                    <div className="lp-ctitle good">✓ 고성과 패턴</div>
                    <ul>{(learned.winning_patterns ?? []).map((w, i) => (
                      <li key={i}><b>{w.pattern}</b>{w.why ? <span className="dim"> — {w.why}</span> : null}</li>
                    ))}</ul>
                  </div>
                  <div>
                    <div className="lp-ctitle bad">✗ 피해야 할 패턴</div>
                    <ul>{(learned.avoid_patterns ?? []).map((a, i) => <li key={i}>{a}</li>)}</ul>
                    {learned.optimal_length_sec && (
                      <div className="lp-len">최적 길이 <b>{learned.optimal_length_sec.min}~{learned.optimal_length_sec.max}초</b></div>
                    )}
                  </div>
                </div>
                <div className="m-hint">
                  이 규칙은 저장돼, 이 채널 영상을 분석할 때 추천 엔진에 자동으로 반영됩니다.
                </div>
              </div>
            ) : learned?.message ? (
              <div className="m-msg" style={{ marginTop: 8 }}>아직 학습 전: {learned.message}</div>
            ) : null}
          </div>
        );
      })()}

      {/* ── LEARN 데이터셋 ───────────────────────────────────────────── */}
      <div className="d-head" style={{ marginTop: 22 }}>
        <b>LEARN 데이터셋</b>
        <span className="m-msg">쌍 {pairs.length}건</span>
        <button onClick={downloadJson} disabled={!pairs.length}>⬇ JSON 내보내기</button>
      </div>

      {total > 0 && (
        <>
          <div className="d-bar">
            <span className="hi" style={{ width: `${pct(tally.high ?? 0)}%` }} />
            <span className="mi" style={{ width: `${pct(tally.mid ?? 0)}%` }} />
            <span className="lo" style={{ width: `${pct(tally.low ?? 0)}%` }} />
          </div>
          <div className="d-legend">
            <span><i className="hi" /> high {tally.high ?? 0} (2배 이상)</span>
            <span><i className="mi" /> mid {tally.mid ?? 0}</span>
            <span><i className="lo" /> low {tally.low ?? 0} (0.7배 미만)</span>
            <span className="d-note">
              성과는 절대 조회수가 아니라 <b>같은 시기(±90일) 채널 숏폼 중앙값 대비 배수</b>다.
              한쪽으로 쏠리면 무엇이 차이를 만드는지 학습할 수 없다.
            </span>
          </div>
        </>
      )}

      {loading ? (
        <div className="empty-note">불러오는 중…</div>
      ) : !pairs.length ? (
        <div className="empty-note">
          이 채널은 아직 매칭된 쌍이 없습니다. 위에서 ⚡ 실행을 눌러 자동 매칭을 걸어보세요.
        </div>
      ) : (
        <div className="d-table">
          <div className="d-tr d-pair d-th">
            <span>티어</span><span>배수</span><span>숏폼</span><span>조회</span>
            <span>구간</span><span>길이</span><span>출처 롱폼</span>
          </div>
          {[...pairs]
            .sort((a, b) => b.performance.ratio - a.performance.ratio)
            .map((p) => (
              <div key={p.pair_id} className="d-tr d-pair">
                <span className={`tier ${p.performance.tier}`}>{p.performance.tier}</span>
                <span>×{p.performance.ratio.toFixed(2)}</span>
                <span className="d-name">{p.short.title ?? p.pair_id}</span>
                <span>{nfmt(p.short.views)}</span>
                <span className="mono">
                  {fmtLong(p.source.segStart)}~{fmtLong(p.source.segEnd)}
                </span>
                <span>{fmtDur(p.source.segLenSec)}</span>
                <span className="d-name dim">{p.source.title ?? p.source.longVideoId}</span>
              </div>
            ))}
        </div>
      )}

      {pairs.length > 0 && (
        <div className="m-hint">
          다음 단계: 각 쌍의 <code>transcript_slice</code>·<code>scene_summary</code>(롱폼 구간의 자막·장면)를
          채우면 LEARN 프롬프트에 그대로 넣을 수 있습니다. 지금은 비어 있습니다.
        </div>
      )}
    </div>
  );
}
