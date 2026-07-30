import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchMatchExport, fetchOverview, fetchViewerSignals,
  type LearnPair, type OverviewChannel, type ViewerSignalsResponse,
} from "../api";
import { fmtDur, fmtLong, nfmt } from "../util";

/**
 * 영상별 작업 — 우리가 작업한 롱폼을 하나하나 열어 보는 화면.
 *
 * 매칭·설명·성과는 모두 채널 단위 export로 이미 만들어져 있다. 여기서는 그걸 **롱폼 기준으로
 * 묶어**, 한 영상에서 어떤 숏폼들이 나왔고(발행 성과 티어), 각 숏폼이 롱폼 어느 구간(자막·장면·
 * 훅·감정)에서 잘렸는지를 한자리에서 보여준다. 새 데이터가 아니라 "작업 결과의 영상별 뷰"다.
 */

const TIER_LABEL: Record<string, string> = { high: "고성과", mid: "보통", low: "저조" };

/** 한 롱폼 + 거기서 나온 매칭 숏폼들. */
interface VideoGroup {
  longVideoId: string;
  title: string | null;
  durationSec: number;
  pairs: LearnPair[];
  described: number;
  tally: { high: number; mid: number; low: number };
}

function groupByLongform(pairs: LearnPair[]): VideoGroup[] {
  const by = new Map<string, VideoGroup>();
  for (const p of pairs) {
    const id = p.source.longVideoId;
    let g = by.get(id);
    if (!g) {
      g = {
        longVideoId: id,
        title: p.source.title,
        durationSec: p.source.durationSec,
        pairs: [],
        described: 0,
        tally: { high: 0, mid: 0, low: 0 },
      };
      by.set(id, g);
    }
    g.pairs.push(p);
    if (p.source.scene_summary || p.source.transcript_slice) g.described++;
    g.tally[p.performance.tier]++;
  }
  const groups = [...by.values()];
  // 각 영상 안: 성과 높은 숏폼 먼저. 영상들: 매칭 많은(=작업 많은) 롱폼 먼저.
  for (const g of groups) g.pairs.sort((a, b) => b.performance.ratio - a.performance.ratio);
  groups.sort((a, b) => b.pairs.length - a.pairs.length);
  return groups;
}

function TierBadge({ tier, ratio }: { tier: string; ratio: number }) {
  return (
    <span className={`vt-tier ${tier}`} title={`같은 시기 채널 중앙값 대비 ${ratio.toFixed(1)}배`}>
      {TIER_LABEL[tier] ?? tier} ×{ratio.toFixed(1)}
    </span>
  );
}

function ShortRow({ p }: { p: LearnPair }) {
  const s = p.source;
  const described = Boolean(s.scene_summary || s.transcript_slice);
  return (
    <div className="vt-short">
      <div className="vt-short-head">
        <a className="vt-short-title" href={`https://youtu.be/${p.short.videoId}`} target="_blank" rel="noreferrer">
          {p.short.title || p.short.videoId}
        </a>
        <TierBadge tier={p.performance.tier} ratio={p.performance.ratio} />
        <span className="vt-views">{nfmt(p.short.views)}회</span>
      </div>
      <div className="vt-seg">
        <span className="vt-seg-range">
          🎬 {fmtLong(s.segStart)} – {fmtLong(s.segEnd)}
          <span className="vt-seg-len">({fmtDur(s.segLenSec)})</span>
        </span>
        {s.hook && <span className="vt-chip hook">훅 {s.hook}</span>}
        {s.emotion && <span className="vt-chip emo">{s.emotion}</span>}
        {!described && <span className="vt-chip todo">설명 미완</span>}
      </div>
      {described && (
        <div className="vt-desc">
          {s.scene_summary && <p className="vt-scene">{s.scene_summary}</p>}
          {s.transcript_slice && <p className="vt-script">“{s.transcript_slice}”</p>}
        </div>
      )}
    </div>
  );
}

/** 시청자 목소리 카드 — content_analysis 완료된 롱폼에 대해 comment_signal 결과 렌더.
 *  카드가 open 될 때 lazy fetch (미열림 상태로는 API 호출 안 함). */
function ViewerVoiceCard({ videoId }: { videoId: string }) {
  const [data, setData] = useState<ViewerSignalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchViewerSignals(videoId)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [videoId]);

  if (loading) {
    return <div className="vt-viewer loading">시청자 반응 로딩 중…</div>;
  }
  if (err) {
    return <div className="vt-viewer err">시청자 반응 로드 실패: {err}</div>;
  }
  if (!data) return null;

  const vs = data.viewer_signals;
  if (!vs) {
    return (
      <div className="vt-viewer empty">
        🗣️ 시청자 목소리 <span className="vt-viewer-empty-note">— {data.reason || "댓글 분석 없음"}</span>
      </div>
    );
  }

  const moments = vs.top_moments ?? [];
  const demands = vs.top_demands ?? [];
  const covered = data.coverage.filter((c) => c.covered).length;
  const total = data.coverage.length;

  return (
    <div className="vt-viewer">
      <div className="vt-viewer-head">
        <b>🗣️ 시청자 목소리</b>
        {vs.dominant_emotion && (
          <span className="vt-viewer-emotion">감정 · {vs.dominant_emotion}</span>
        )}
        {total > 0 && (
          <span className={`vt-viewer-cov ${covered === total ? "full" : covered > 0 ? "partial" : "none"}`}>
            시청자 지목 시간 커버 {covered}/{total}
          </span>
        )}
      </div>
      {moments.length > 0 && (
        <div className="vt-viewer-block">
          <div className="vt-viewer-label">지목 순간 (❤ 순)</div>
          <ul className="vt-viewer-list">
            {moments.slice(0, 4).map(([text, likes], i) => (
              <li key={i}>
                <span className="vt-viewer-likes">{nfmt(likes)}❤</span>
                <span className="vt-viewer-text">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.coverage.length > 0 && (
        <div className="vt-viewer-block">
          <div className="vt-viewer-label">시청자 명시 시간</div>
          <div className="vt-viewer-ts">
            {data.coverage.map((c, i) => (
              <span
                key={i}
                className={`vt-viewer-chip ${c.covered ? "cov" : "miss"}`}
                title={c.covered
                  ? `쇼츠 #${c.byShortRank ?? "?"} 커버 (${c.likes}❤)`
                  : `미커버 · ${c.likes}❤ · 규칙 강화 필요`}
              >
                {c.covered ? "✓" : "⚠"} {c.mmss} <em>{c.likes}❤</em>
              </span>
            ))}
          </div>
        </div>
      )}
      {demands.length > 0 && (
        <div className="vt-viewer-block">
          <div className="vt-viewer-label">시청자 요청</div>
          <ul className="vt-viewer-list">
            {demands.slice(0, 3).map(([text, likes], i) => (
              <li key={i}>
                <span className="vt-viewer-likes">{nfmt(likes)}❤</span>
                <span className="vt-viewer-text">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function VideoCard({ g }: { g: VideoGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`vt-card${open ? " open" : ""}`}>
      <button className="vt-card-head" onClick={() => setOpen((v) => !v)}>
        <span className="vt-caret">{open ? "▾" : "▸"}</span>
        <span className="vt-title">{g.title || g.longVideoId}</span>
        <span className="vt-meta">
          {g.durationSec > 0 && <span className="vt-dur">{fmtDur(g.durationSec)}</span>}
          <span className="vt-count">숏폼 {g.pairs.length}개</span>
          <span className="vt-count sub">설명 {g.described}/{g.pairs.length}</span>
          <span className="vt-tiers">
            {g.tally.high > 0 && <b className="high">고 {g.tally.high}</b>}
            {g.tally.mid > 0 && <b className="mid">보 {g.tally.mid}</b>}
            {g.tally.low > 0 && <b className="low">저 {g.tally.low}</b>}
          </span>
        </span>
        <a
          className="vt-yt"
          href={`https://youtu.be/${g.longVideoId}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="롱폼 원본 열기"
        >
          ↗
        </a>
      </button>
      {open && (
        <div className="vt-shorts">
          <ViewerVoiceCard videoId={g.longVideoId} />
          {g.pairs.map((p) => (
            <ShortRow key={p.pair_id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function VideosTab() {
  const [channels, setChannels] = useState<OverviewChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [pairs, setPairs] = useState<LearnPair[]>([]);
  const [channelName, setChannelName] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    void fetchOverview()
      .then((cs) => {
        setChannels(cs);
        setChannelId((cur) => cur || cs.find((c) => c.matched > 0)?.channelId || cs[0]?.channelId || "");
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetchMatchExport(id);
      setPairs(r.pairs);
      setChannelName(r.channelName);
    } catch (e) {
      setErr((e as Error).message);
      setPairs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(channelId);
  }, [channelId, load]);

  const groups = useMemo(() => groupByLongform(pairs), [pairs]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return groups;
    return groups.filter(
      (g) =>
        (g.title || "").toLowerCase().includes(t) ||
        g.pairs.some((p) => (p.short.title || "").toLowerCase().includes(t)),
    );
  }, [groups, q]);

  const totalShorts = pairs.length;
  const totalDescribed = groups.reduce((n, g) => n + g.described, 0);

  return (
    <div className="vt">
      <div className="vt-bar">
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {channels.map((c) => (
            <option key={c.channelId} value={c.channelId}>
              {c.channelName}
              {typeof c.matched === "number" ? ` · 매칭 ${c.matched}` : ""}
            </option>
          ))}
        </select>
        <input
          className="vt-search"
          placeholder="영상·숏폼 제목 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {loading && <span className="vt-loading">불러오는 중…</span>}
      </div>

      {err && <div className="vt-err">불러오지 못했습니다: {err}</div>}

      {!loading && !err && groups.length === 0 && (
        <div className="vt-empty">
          <b>{channelName || "이 채널"}</b>에 아직 매칭된 작업이 없습니다.
          <br />
          「🔗 숏폼 매칭」 탭에서 숏폼↔롱폼을 이으면 여기 영상별로 쌓입니다.
        </div>
      )}

      {groups.length > 0 && (
        <>
          <div className="vt-summary">
            <b>{channelName}</b> — 작업한 롱폼 <b>{groups.length}편</b> · 매칭 숏폼{" "}
            <b>{totalShorts}개</b> · 설명 완료 {totalDescribed}/{totalShorts}
          </div>
          <div className="vt-list">
            {filtered.map((g) => (
              <VideoCard key={g.longVideoId} g={g} />
            ))}
            {filtered.length === 0 && <div className="vt-empty">검색 결과 없음</div>}
          </div>
        </>
      )}
    </div>
  );
}
