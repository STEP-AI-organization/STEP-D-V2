"""
STEP D Core — Cast registry matching → per-person appearance timeline

The differentiator: a generic tool sees "a woman in her 20s"; STEP D sees "23기 영숙".
That identification comes from the LOWER-THIRD NAME CAPTION the broadcaster already
burned into the frame (ocr.py / vision.py fill `scene["on_screen_names"]`) — matched
against a per-program cast registry the operator maintains.

Explicitly NOT face recognition. We never claim identity from a face; the evidence is
the on-screen name caption plus the scene span it appeared in. That keeps us out of
biometric territory (PIPA 민감정보) and keeps every claim auditable back to a frame.

Trust model — nothing is auto-confirmed:
  registry hit (exact/alias)  → status "matched"    (name normalized to the registry entry)
  registry hit (fuzzy)        → status "matched"    with a lower confidence + matchType "fuzzy"
  no registry hit             → status "candidate"  (kept, never promoted — the operator decides)
An empty/absent registry is a no-op for matching: every name still becomes a candidate,
so the timeline is useful on day one and gets normalized as the registry fills in.

Confidence is evidence-weighted, not a guess:
  - match quality (exact > alias > fuzzy ratio)
  - how the name was read (Gemini-verified frame > PaddleOCR-only frame — see `_prefiltered`)
  - how many scenes corroborate it (one frame is weak; ten are not)

Output shape (also what `analysis.json["cast"]` carries):
    {"registrySize": n, "people": [ {castId, name, role, status, confidence, matchType,
                                     sceneCount, totalSec, appearances: [{start,end,scenes,
                                     confidence, source}]}, ... ]}

Run:
    python -m core.cast core/scenes.json --registry core/cast_registry.json
"""
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# Two appearances closer than this are the same continuous appearance — a name caption
# flashes on for a few seconds, not for every scene the person is in, so bridging the
# gap is what turns caption events into an actual "등장 구간".
MERGE_GAP_SEC = 12.0

# Below this, a fuzzy name is not the registry entry — it's a different (candidate) name.
FUZZY_MIN_RATIO = 0.75

# Confidence ceilings per match quality. Deliberately < 1.0: OCR on broadcast lower-thirds
# is good, not certain, and the operator is the one who confirms.
_MATCH_BASE = {"exact": 0.85, "alias": 0.80, "fuzzy": 0.55, "none": 0.40}

_PUNCT = re.compile(r"[\s·・.,_\-—~!?'\"“”‘’()\[\]{}]+")


def normalize_name(raw: str) -> str:
    """Canonical form for comparison: strip whitespace/punctuation, casefold latin.
    '23기  영숙!' → '23기영숙'. Hangul is unaffected by casefold."""
    return _PUNCT.sub("", str(raw or "")).casefold()


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


# ── registry ────────────────────────────────────────────────────────────────────

def load_registry(path) -> list[dict]:
    """Read a cast registry JSON. Accepts either a bare list or {"cast": [...]}.
    Returns [] on any problem — a missing registry must never fail the pipeline."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as e:
        print(f"   (캐스트 레지스트리 로드 실패, 후보 모드로 진행: {str(e)[:80]})")
        return []
    if isinstance(raw, dict):
        raw = raw.get("cast") or raw.get("members") or []
    if not isinstance(raw, list):
        return []
    out = []
    for m in raw:
        if not isinstance(m, dict):
            continue
        name = str(m.get("name") or "").strip()
        if not name:
            continue
        aliases = [str(a).strip() for a in (m.get("aliases") or []) if str(a).strip()]
        out.append({
            "castId": str(m.get("castId") or m.get("id") or name),
            "name": name,
            "aliases": aliases,
            "role": str(m.get("role") or ""),
            "season": str(m.get("season") or ""),
        })
    return out


def match_name(raw: str, registry: list[dict]) -> Optional[dict]:
    """Match one OCR'd name caption against the registry.

    Returns {castId, name, role, matchType, quality} or None when nothing matches.
    Tried in order — exact, alias, containment, fuzzy — so a real hit never loses to a
    weaker one. `quality` (0–1) feeds confidence; `name` is the REGISTRY spelling, which
    is how '영 숙' and '영숙' collapse onto one person in the timeline.
    """
    n = normalize_name(raw)
    if not n or not registry:
        return None

    def hit(m: dict, match_type: str, quality: float) -> dict:
        return {"castId": m["castId"], "name": m["name"], "role": m.get("role", ""),
                "matchType": match_type, "quality": quality}

    for m in registry:  # exact on the canonical name
        if normalize_name(m["name"]) == n:
            return hit(m, "exact", 1.0)
    for m in registry:  # exact on a registered alias ('23기 영숙', '영숙이', …)
        if any(normalize_name(a) == n for a in m["aliases"]):
            return hit(m, "alias", 1.0)
    # Containment: the caption carries the registry name plus decoration ('23기영숙' ⊃ '영숙').
    # Guarded by a 2-char floor so single-letter entries don't swallow everything.
    for m in registry:
        cand = normalize_name(m["name"])
        if len(cand) >= 2 and (cand in n or n in cand):
            return hit(m, "alias", 0.9)
    # Fuzzy: OCR misreads a stroke ('영숙' vs '영속'). Best ratio wins, above the floor.
    best, best_r = None, 0.0
    for m in registry:
        for cand in [m["name"], *m["aliases"]]:
            r = _ratio(n, normalize_name(cand))
            if r > best_r:
                best, best_r = m, r
    if best is not None and best_r >= FUZZY_MIN_RATIO:
        return hit(best, "fuzzy", best_r)
    return None


# ── timeline ────────────────────────────────────────────────────────────────────

def _scene_source(scene: dict) -> str:
    """Where this scene's on_screen_names came from. Gemini re-read the top-N frames in
    its vision call (validation); pre-filtered frames carry PaddleOCR text only."""
    return "ocr" if scene.get("_prefiltered") else "gemini"


def _merge_events(events: list[dict]) -> list[dict]:
    """Caption events (one per scene) → continuous appearance spans.
    Events within MERGE_GAP_SEC join; each span keeps the scenes that evidence it."""
    if not events:
        return []
    events = sorted(events, key=lambda e: e["start"])
    spans: list[dict] = []
    for e in events:
        if spans and e["start"] - spans[-1]["end"] <= MERGE_GAP_SEC:
            cur = spans[-1]
            cur["end"] = max(cur["end"], e["end"])
            cur["scenes"].append(e["scene"])
            cur["sources"].append(e["source"])
        else:
            spans.append({"start": e["start"], "end": e["end"],
                          "scenes": [e["scene"]], "sources": [e["source"]]})
    out = []
    for s in spans:
        gemini = sum(1 for x in s["sources"] if x == "gemini")
        out.append({
            "start": round(s["start"], 1),
            "end": round(s["end"], 1),
            "scenes": s["scenes"],
            # A span corroborated by a Gemini-verified frame is worth more than OCR alone.
            "source": "gemini" if gemini else "ocr",
        })
    return out


def _confidence(match_type: str, quality: float, spans: list[dict], events: int) -> float:
    """Evidence-weighted confidence in [0,1).

    base(match quality) × corroboration(how many scenes) × verification(Gemini vs OCR-only).
    Never reaches 1.0 — this is OCR evidence, not a confirmed identity. The operator's
    confirmation is what makes it certain, and that lives in the DB, not here.
    """
    base = _MATCH_BASE.get(match_type, 0.4)
    if match_type == "fuzzy":
        base *= max(0.0, min(1.0, quality))  # a 0.76-ratio fuzzy hit is barely a hit
    # Saturating corroboration: 1 scene → 0.71, 3 → 0.83, 6+ → 1.0 (capped).
    corrob = min(1.0, 0.65 + 0.35 * (min(events, 6) / 6.0))
    verified = any(s["source"] == "gemini" for s in spans)
    return round(min(0.99, base * corrob * (1.0 if verified else 0.85)), 3)


def build_cast_timeline(scenes: list[dict], registry: Optional[list[dict]] = None) -> dict:
    """scenes[] (with on_screen_names) + cast registry → per-person appearance timeline.

    Registry hits are normalized onto the registry entry and marked "matched"; unknown
    names are kept as "candidate" — never auto-promoted, because a wrong auto-confirm is
    worse than an unresolved candidate the operator can approve in one click.
    """
    registry = registry or []
    # person key → {meta, events[]}. Registry hits key by castId so aliases collapse;
    # candidates key by normalized caption so OCR spelling noise collapses too.
    people: dict[str, dict] = {}

    for sc in scenes:
        names = sc.get("on_screen_names") or []
        if not isinstance(names, list):
            continue
        start, end = float(sc.get("start", 0)), float(sc.get("end", 0))
        src = _scene_source(sc)
        for raw in names:
            raw = str(raw or "").strip()
            if not raw:
                continue
            m = match_name(raw, registry)
            if m:
                key = f"cast:{m['castId']}"
                meta = {"castId": m["castId"], "name": m["name"], "role": m.get("role", ""),
                        "status": "matched", "matchType": m["matchType"], "quality": m["quality"]}
            else:
                key = f"cand:{normalize_name(raw)}"
                meta = {"castId": None, "name": raw, "role": "",
                        "status": "candidate", "matchType": "none", "quality": 0.0}
            p = people.setdefault(key, {"meta": meta, "events": [], "evidence": set()})
            # Keep the strongest match seen for this person (a later exact beats an earlier fuzzy).
            if meta["quality"] > p["meta"]["quality"]:
                p["meta"] = meta
            p["events"].append({"start": start, "end": end, "scene": sc.get("index"), "source": src})
            p["evidence"].add(raw)

    out = []
    for p in people.values():
        spans = _merge_events(p["events"])
        meta = p["meta"]
        total = round(sum(s["end"] - s["start"] for s in spans), 1)
        out.append({
            "castId": meta["castId"],
            "name": meta["name"],
            "role": meta["role"],
            "status": meta["status"],
            "matchType": meta["matchType"],
            "confidence": _confidence(meta["matchType"], meta["quality"], spans, len(p["events"])),
            "sceneCount": len(p["events"]),
            "totalSec": total,
            # What the OCR actually read — the audit trail behind the normalized name.
            "evidence": sorted(p["evidence"]),
            "appearances": spans,
        })
    # Registry-matched people first, then by screen time — the operator's reading order.
    out.sort(key=lambda p: (p["status"] != "matched", -p["totalSec"]))
    return {
        "registrySize": len(registry),
        "matchedCount": sum(1 for p in out if p["status"] == "matched"),
        "candidateCount": sum(1 for p in out if p["status"] == "candidate"),
        "people": out,
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m core.cast <scenes.json> [--registry <cast.json>]")
        sys.exit(1)
    scenes = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    registry = []
    if "--registry" in sys.argv:
        registry = load_registry(sys.argv[sys.argv.index("--registry") + 1])
    result = build_cast_timeline(scenes, registry)
    out = Path(sys.argv[1]).parent / "cast.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"=== 캐스트 타임라인 (레지스트리 {result['registrySize']}명) ===")
    for p in result["people"]:
        mark = "✓" if p["status"] == "matched" else "?"
        spans = ", ".join(f"{s['start']:.0f}~{s['end']:.0f}s" for s in p["appearances"][:4])
        print(f"  {mark} {p['name']:<10} conf {p['confidence']:.2f} · {p['sceneCount']}씬 · {p['totalSec']:.0f}s · {spans}")
    print(f"\n  → {out}")


if __name__ == "__main__":
    main()
