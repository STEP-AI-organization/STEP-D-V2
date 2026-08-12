"""
STEP D Core — Channel(배포처) fit axis

The master plan's score is `최종 = 융합 × 채널적합 × 프로그램적합`. Two of the three existed:
융합(Gemini appeal) and 프로그램적합(recommend.apply_profile_fit). **채널적합 did not** — this
module is that missing axis. It is the reason the same episode yields a different pick for
YouTube Shorts than for SMR: a 25s vertical punchline is a great Short and an unusable SMR
clip, and until now nothing in the code knew that.

Rule-based on purpose. Per the feasibility study (docs/research/highlight-model-feasibility.md
§7), this is 1단계 — a declarative per-destination profile, no learned model. The learned
re-ranker slots in later at the same layer (recommend.apply_learned_rerank), which is why the
fit factors here are plain multipliers rather than anything trained.

Four factors per (candidate × channel), each grounded in a signal we already persist:
  len_fit      candidate length vs the destination's usable range   ← short.start/end
  hook_w       destination's appetite for that hook category        ← short.hook
  caption_fit  sound-off destinations need burned-in captions/talk  ← scene.heur.caption/dialogue
  aspect_fit   9:16 crop survives few faces, not a wide 5-shot      ← scene.heur.faces
`caption_fit`/`aspect_fit` read the scenes the candidate spans, so they degrade to a neutral
1.0 when the pre-filter never ran (no `heur`) — never a penalty for missing data.

Non-destructive by construction: this module only ADDS `channel_scores` to each short. The
board's existing `final_score`/`rank` (appeal × program_fit) are left exactly as they were,
so the per-destination matrix is new information rather than a re-ordering of the old.
"""
from typing import Optional

# The 8 hook categories the program profile weights (mirrors recommend.HOOK_KEYS).
# Kept as a literal so channels.py has no import cycle with recommend.py.
HOOK_KEYS = ("반전", "감정고조", "돌직구", "질문", "정보성", "웃음", "갈등", "공감")


# ── destination presets ─────────────────────────────────────────────────────────
#
# Editable data, not logic. Each preset says how a destination consumes a clip:
#   minSec/maxSec  hard usable range (outside → heavy penalty, never a silent drop)
#   idealSec       the length the destination actually rewards
#   aspect         target frame — drives how much the 9:16 crop has to throw away
#   hookSec        how fast the hook must land (Shorts swipe in ~2s; SMR viewers don't)
#   captionDep     0–1 how much the destination depends on burned-in text (sound-off feed)
#   hookWeights    per-destination appetite by hook category (1.0 = neutral)

CHANNEL_PRESETS: dict[str, dict] = {
    "youtube_shorts": {
        "label": "YouTube Shorts",
        "minSec": 8, "maxSec": 60, "idealSec": 35,
        "aspect": "9:16", "hookSec": 2.0, "captionDep": 0.8,
        "hookWeights": {"반전": 1.3, "웃음": 1.25, "감정고조": 1.15, "돌직구": 1.2,
                        "갈등": 1.1, "질문": 1.0, "공감": 1.0, "정보성": 0.85},
    },
    "instagram_reels": {
        "label": "Instagram Reels",
        "minSec": 5, "maxSec": 90, "idealSec": 25,
        "aspect": "9:16", "hookSec": 1.5, "captionDep": 0.9,
        "hookWeights": {"웃음": 1.3, "공감": 1.25, "감정고조": 1.2, "반전": 1.15,
                        "돌직구": 1.05, "갈등": 0.95, "질문": 0.95, "정보성": 0.8},
    },
    "smr": {
        "label": "SMR (네이버/카카오 등 포털)",
        "minSec": 40, "maxSec": 180, "idealSec": 90,
        # Portal VOD is the broadcast master's frame — no vertical crop, so aspect_fit is neutral.
        "aspect": "16:9", "hookSec": 6.0, "captionDep": 0.35,
        "hookWeights": {"정보성": 1.2, "감정고조": 1.1, "갈등": 1.1, "반전": 1.05,
                        "질문": 1.0, "웃음": 1.0, "공감": 1.0, "돌직구": 0.95},
    },
}

DEFAULT_CHANNELS = ("youtube_shorts", "instagram_reels", "smr")

# Floor for the length factor. A candidate outside the usable range is deranked hard but
# NOT dropped — dropping is the program profile's taboo hard-filter, and conflating the two
# would let a preset silently delete a candidate the operator may still want.
_LEN_FLOOR = 0.25


def resolve_channels(names: Optional[list[str]]) -> dict[str, dict]:
    """Names → presets. Unknown names are skipped (with a note), not fatal.
    None/empty → the three built-in destinations."""
    if not names:
        return {k: CHANNEL_PRESETS[k] for k in DEFAULT_CHANNELS}
    out = {}
    for n in names:
        key = str(n).strip().lower()
        if key in CHANNEL_PRESETS:
            out[key] = CHANNEL_PRESETS[key]
        elif key:
            print(f"   (알 수 없는 배포처 무시: {key})")
    return out


# ── per-factor scoring ──────────────────────────────────────────────────────────

def _len_fit(length: float, p: dict) -> float:
    """Peaks at idealSec, ≥0.7 anywhere inside the usable range, and drops to a 0.25–0.4
    band outside it — deranked out of contention but still visible to the operator."""
    if length <= 0:
        return _LEN_FLOOR
    lo, hi, ideal = float(p["minSec"]), float(p["maxSec"]), float(p["idealSec"])
    if length < lo or length > hi:
        # How far outside, relative to the window's own width — a 5s miss on a 20s window
        # is worse than a 5s miss on a 140s one.
        over = (lo - length) if length < lo else (length - hi)
        return round(max(_LEN_FLOOR, 0.4 - min(0.15, over / max(1.0, hi - lo))), 3)
    # Inside the window: proximity to the ideal, floored at 0.7 so a usable clip stays usable.
    return round(max(0.7, 1.0 - abs(length - ideal) / max(1.0, ideal) * 0.3), 3)


def _spanned_scenes(scenes: list[dict], start: float, end: float) -> list[dict]:
    """Scenes overlapping [start,end] — the candidate's own feature source."""
    return [s for s in scenes
            if float(s.get("end", 0)) > start and float(s.get("start", 0)) < end]


def _mean_heur(spanned: list[dict], key: str) -> Optional[float]:
    """Mean of one pre-filter signal over the spanned scenes, or None when the pre-filter
    never ran (fewer frames than the Gemini budget, VISION_PREFILTER=off, no OpenCV)."""
    vals = [float(s["heur"][key]) for s in spanned
            if isinstance(s.get("heur"), dict) and isinstance(s["heur"].get(key), (int, float))]
    return (sum(vals) / len(vals)) if vals else None


def _caption_fit(spanned: list[dict], p: dict) -> float:
    """Sound-off destinations (Shorts/Reels) reward burned-in captions and dense talk.
    `captionDep` scales how much this matters: SMR barely cares, Reels cares a lot.
    Neutral 1.0 when the signals are absent."""
    dep = float(p.get("captionDep", 0.5))
    cap = _mean_heur(spanned, "caption")
    dia = _mean_heur(spanned, "dialogue")
    if cap is None and dia is None:
        return 1.0
    # heur values are raw (edge density ~0–0.3, chars/sec ~0–10) — normalize to rough [0,1]
    # against typical broadcast ranges rather than the batch, so the factor is comparable
    # across episodes (a batch-relative norm would make one clip's fit depend on its siblings).
    cap_n = min(1.0, (cap or 0.0) / 0.15)
    dia_n = min(1.0, (dia or 0.0) / 6.0)
    richness = 0.6 * cap_n + 0.4 * dia_n
    # dep=0 → always 1.0; dep=1 → 0.8…1.2 swing on richness.
    return round(1.0 + dep * (richness - 0.5) * 0.4, 3)


def _aspect_fit(spanned: list[dict], p: dict) -> float:
    """9:16 keeps ~30% of a 16:9 frame's width — a 5-person wide shot doesn't survive the
    crop, a 1–2 person close-up does. Uses the pre-filter's face count as the proxy.
    Neutral for 16:9 destinations (no crop) and when face counts are absent."""
    if str(p.get("aspect")) != "9:16":
        return 1.0
    faces = _mean_heur(spanned, "faces")
    if faces is None:
        return 1.0
    if faces <= 2.0:
        return 1.05          # close-up / two-shot — ideal vertical
    if faces <= 3.5:
        return 1.0
    return round(max(0.8, 1.0 - (faces - 3.5) * 0.06), 3)


def channel_fit(short: dict, scenes: list[dict], preset: dict) -> dict:
    """One (candidate × channel) cell: the fit factor plus the factors that produced it.
    The breakdown is returned — not just the product — so the operator (and the Lab) can
    see WHY a clip ranks 1st for Shorts and 6th for SMR."""
    start, end = float(short.get("start", 0) or 0), float(short.get("end", 0) or 0)
    length = max(0.0, end - start)
    spanned = _spanned_scenes(scenes, start, end)
    hw = preset.get("hookWeights") or {}
    hook = str(short.get("hook", "")).strip()

    len_fit = _len_fit(length, preset)
    hook_w = float(hw.get(hook, 1.0))
    cap_fit = _caption_fit(spanned, preset)
    asp_fit = _aspect_fit(spanned, preset)
    fit = round(len_fit * hook_w * cap_fit * asp_fit, 3)
    return {
        "fit": fit,
        "len_fit": len_fit, "hook_w": round(hook_w, 3),
        "caption_fit": cap_fit, "aspect_fit": asp_fit,
        "usable": preset["minSec"] <= length <= preset["maxSec"],
        "lengthSec": round(length, 1),
    }


def apply_channel_fit(
    shorts: list[dict],
    scenes: list[dict],
    channels: Optional[list[str]] = None,
) -> list[dict]:
    """Add the (후보 × 배포처) matrix to each short. ADDITIVE — `final_score`/`rank` untouched.

    Per short: `channel_scores[ch] = {fit, score, rank, …factors}` where
        score = final_score(융합 × 프로그램적합) × fit(채널적합)
    i.e. the plan's `최종 = 융합 × 채널적합 × 프로그램적합`, evaluated per destination instead of
    collapsed into one number. `rank` is that destination's own ordering — which is what makes
    Shorts and SMR disagree about the same episode.

    No-op (returns shorts unchanged) when there are no shorts or no resolvable destinations.
    """
    presets = resolve_channels(channels)
    if not shorts or not presets:
        return shorts
    scenes = scenes or []

    out = [dict(s) for s in shorts]
    for s in out:
        # Fall back to appeal when program-fit never ran (no profile → no final_score).
        base = s.get("final_score")
        if not isinstance(base, (int, float)):
            base = float(s.get("appeal") or 3.0)
        cells = {}
        for key, preset in presets.items():
            cell = channel_fit(s, scenes, preset)
            cell["score"] = round(float(base) * cell["fit"], 3)
            cell["label"] = preset["label"]
            cells[key] = cell
        s["channel_scores"] = cells

    # Per-destination ranking: each channel orders the candidates by ITS own score.
    for key in presets:
        ranked = sorted(out, key=lambda s: -s["channel_scores"][key]["score"])
        for i, s in enumerate(ranked, 1):
            s["channel_scores"][key]["rank"] = i
    return out


def best_channel(short: dict) -> Optional[str]:
    """The destination this candidate fits best — a convenience for UI/summary lines.
    None when the matrix wasn't computed."""
    cells = short.get("channel_scores")
    if not isinstance(cells, dict) or not cells:
        return None
    return max(cells.items(), key=lambda kv: kv[1].get("score", 0))[0]
