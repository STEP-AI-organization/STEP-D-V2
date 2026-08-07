"""채널 스타일 학습 — 수집 + 프로파일링 (프로그램 단위 · 서비스에서 호출).

scripts/thumbnail_style_collect.py · thumbnail_style_profile.py 를 core 로 옮겨
워커가 부를 수 있게 한 것. 스크립트는 로컬 실험용으로 두고, 서비스 경로는 여기다.

학습이라 부르지만 가중치는 안 건드린다 (gpt-image-2 는 파인튜닝이 없다):
채널 썸네일에서 규칙을 뽑아 프롬프트에 심고, 전형적인 썸네일 2장을 참고로 넣는다.
집계는 빈도·중앙값으로 한다 — LLM 에 맡기면 실행마다 프로파일이 달라져 스타일이 흔들린다.
"""
from __future__ import annotations

import collections
import json
import pathlib
import statistics
import subprocess
import urllib.request
from typing import Any

SYSTEM = """너는 한국 방송사 유튜브 썸네일 아트디렉터다.
첨부된 썸네일 1장을 보고 아래 JSON 스키마로만 답한다. 설명 문장을 덧붙이지 않는다.

{
  "person_count": 0,
  "caption_lines": 0,
  "caption_position": "bottom-left",
  "caption_max_chars": 0,
  "caption_colors": ["white"],
  "highlight_style": "키워드만 다른 색",
  "has_border": true,
  "border_desc": "파스텔 그라디언트 프레임",
  "has_logo": true,
  "logo_position": "top-left",
  "background": "실내 스튜디오",
  "tone": "밝고 화사함",
  "person_layout": "가로로 나란히"
}"""


# ── 수집 ──────────────────────────────────────────────────────────────────────

def list_playlists(channel_url: str, limit: int = 50) -> list[dict[str, Any]]:
    """채널의 재생목록 목록.

    큰 채널은 프로그램·기수를 재생목록으로 나눠 담는다. 채널 전체로 학습하면
    여러 프로그램 톤이 뭉개지므로, 재생목록 단위로 고르게 한다.
    """
    url = channel_url.rstrip("/")
    if "/playlists" not in url and "list=" not in url:
        url = url.split("/videos")[0] + "/playlists"
    r = subprocess.run(
        ["yt-dlp", "--flat-playlist", "--playlist-end", str(limit), "-J", url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 실패: {(r.stderr or '')[-300:]}")
    out = []
    for e in (json.loads(r.stdout).get("entries") or []):
        pid = e.get("id")
        if not pid:
            continue
        out.append({
            "playlistId": pid,
            "title": e.get("title") or "",
            "url": e.get("url") or f"https://www.youtube.com/playlist?list={pid}",
            "videoCount": e.get("playlist_count"),
        })
    return out


def collect_thumbnails(source_url: str, out_dir: pathlib.Path, limit: int = 50) -> int:
    """재생목록 또는 채널 → 썸네일 이미지.

    **재생목록 URL 을 권한다.** 채널 전체는 프로그램이 섞여 스타일이 뭉개진다.
    yt-dlp 라 YOUTUBE_API_KEY·쿼터가 필요 없고, 둘 다 같은 방식으로 처리된다.
    """
    img_dir = out_dir / "thumbs"
    img_dir.mkdir(parents=True, exist_ok=True)

    r = subprocess.run(
        ["yt-dlp", "--flat-playlist", "--playlist-end", str(limit), "-J", source_url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp 실패: {(r.stderr or '')[-300:]}")

    entries = (json.loads(r.stdout).get("entries") or [])[:limit]
    saved: list[dict[str, Any]] = []
    for e in entries:
        vid = e.get("id")
        if not vid:
            continue
        dest = img_dir / f"{vid}.jpg"
        if dest.exists() or _fetch_thumb(vid, dest):
            saved.append({"videoId": vid, "title": e.get("title") or ""})

    (out_dir / "videos.json").write_text(
        json.dumps({"source": source_url, "videos": saved},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    return len(saved)


def _fetch_thumb(video_id: str, dest: pathlib.Path) -> bool:
    """maxres 우선. 없는 영상이 있어 hq 로 폴백한다."""
    for name in ("maxresdefault", "hqdefault"):
        try:
            with urllib.request.urlopen(
                    f"https://i.ytimg.com/vi/{video_id}/{name}.jpg", timeout=20) as r:
                if r.status != 200:
                    continue
                body = r.read()
            if len(body) < 5000:      # 회색 플레이스홀더
                continue
            dest.write_bytes(body)
            return True
        except Exception:
            continue
    return False


# ── 분석·집계 ─────────────────────────────────────────────────────────────────

def _analyze_one(client, model, img_bytes: bytes) -> dict | None:
    from google.genai import types

    from core.retry import call_with_retry
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=model,
            contents=[types.Part.from_bytes(data=img_bytes, mime_type="image/jpeg"),
                      "이 썸네일을 분석해."],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM, temperature=0,
                response_mime_type="application/json",
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=1024,
            ),
        ))
        return json.loads(resp.text or "{}")
    except Exception:
        return None


def _top(values: list, k: int = 3) -> list[tuple[str, int]]:
    vals = [str(v).strip() for v in values if str(v or "").strip()]
    return collections.Counter(vals).most_common(k)


def aggregate(rows: list[dict]) -> dict:
    n = len(rows)
    chars = [r.get("caption_max_chars") for r in rows
             if isinstance(r.get("caption_max_chars"), (int, float))]
    colors = [c for r in rows for c in (r.get("caption_colors") or [])]
    return {
        "sampleSize": n,
        "personCount": _top([r.get("person_count") for r in rows]),
        "captionLines": _top([r.get("caption_lines") for r in rows]),
        "captionPosition": _top([r.get("caption_position") for r in rows]),
        "captionMaxChars": round(statistics.median(chars), 1) if chars else None,
        "captionColors": _top(colors, 5),
        "highlightStyle": _top([r.get("highlight_style") for r in rows], 2),
        "borderRate": round(sum(1 for r in rows if r.get("has_border")) / max(n, 1), 2),
        "borderDesc": _top([r.get("border_desc") for r in rows], 2),
        "logoRate": round(sum(1 for r in rows if r.get("has_logo")) / max(n, 1), 2),
        "logoPosition": _top([r.get("logo_position") for r in rows], 2),
        "background": _top([r.get("background") for r in rows], 3),
        "tone": _top([r.get("tone") for r in rows], 3),
        "personLayout": _top([r.get("person_layout") for r in rows], 3),
    }


def to_prompt_block(title: str, agg: dict) -> str:
    """생성 프롬프트에 심을 한국어 블록. 길게 쓰지 않는다 — 길수록 결과가 나빠졌다."""
    def first(key, default=""):
        top = agg.get(key) or []
        return top[0][0] if top else default

    parts = [f"{title} 채널의 썸네일 스타일을 따라줘."]
    if agg.get("borderRate", 0) >= 0.5 and first("borderDesc"):
        parts.append(f"바깥에 {first('borderDesc')}를 두르고,")
    if agg.get("logoRate", 0) >= 0.5:
        parts.append(f"{first('logoPosition', 'top-left')} 에 프로그램 로고를 작게 넣어줘.")
    parts.append(f"자막은 {first('captionPosition', 'bottom-left')} 에 "
                 f"{first('captionLines', '2')}줄로, {first('highlightStyle', '키워드만 다른 색')}.")
    if first("tone"):
        parts.append(f"전체 톤은 {first('tone')}.")
    return " ".join(parts)


def build_profile(program_dir: pathlib.Path, title: str, sample: int = 20) -> dict:
    """수집된 썸네일 → style_profile.json · style_prompt.txt · refs.json."""
    import os

    from google import genai

    from core.models import VISION

    thumbs = sorted((program_dir / "thumbs").glob("*.jpg"))[:sample]
    if not thumbs:
        raise RuntimeError(f"썸네일 없음: {program_dir/'thumbs'}")

    client = genai.Client(
        vertexai=True,
        project=os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d",
        location=os.environ.get("VERTEX_LOCATION") or "asia-northeast3",
    )

    rows = []
    for p in thumbs:
        r = _analyze_one(client, VISION, p.read_bytes())
        if r:
            r["_file"] = p.name
            rows.append(r)
    if not rows:
        raise RuntimeError("Vision 분석이 모두 실패했다")

    agg = aggregate(rows)
    block = to_prompt_block(title, agg)

    (program_dir / "style_profile.json").write_text(
        json.dumps({"title": title, "aggregate": agg, "rows": rows},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    (program_dir / "style_prompt.txt").write_text(block, encoding="utf-8")

    # 참고 이미지 = 가장 흔한 인물 수를 가진 것 2장 (그 채널의 전형)
    common = agg["personCount"][0][0] if agg["personCount"] else None
    refs = [r["_file"] for r in rows if str(r.get("person_count")) == str(common)][:2]
    (program_dir / "refs.json").write_text(
        json.dumps({"refs": refs}, ensure_ascii=False, indent=2), encoding="utf-8")

    return {"sampleSize": agg["sampleSize"], "prompt": block, "refs": refs}
