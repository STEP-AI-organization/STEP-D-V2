"""
STEP D Core — Transcript Refinement (STT post-processing)

Cleans the raw faster-whisper transcript into readable subtitles with Gemini on
Vertex AI: removes repetition, tidies fragments/stutters, adds punctuation, and
fixes obvious mis-recognitions from context. This is STT *cleanup only* — it does
not summarize, invent, or pick clips.

Timestamps are preserved 1:1 with the input segments (a fully-redundant line just
becomes empty), so the refined SRT stays perfectly in sync with the video. Word-level
timestamps (`words`, present on the whisper path) ride along too, for \\k karaoke burn-in.

Auth: Application Default Credentials — run `gcloud auth application-default login`
once. No API key; uses the GCP project's Vertex AI.

Run:
    python -m core.refine core/pipeline_output.json
    python -m core.refine core/pipeline_output.json --out core/refined
"""
import json
import os
import sys
from pathlib import Path

# Windows consoles default to cp949 and crash on non-Latin/emoji output.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
# Seoul — transcripts can carry personal info; keep processing in-country (data residency).
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
BATCH = 40  # segments per Gemini call — small enough to stay coherent, big enough to be cheap

SYSTEM = """너는 한국어 예능/방송 자막 정제 전문가다.
입력은 자동 음성 인식(STT) 결과로, 번호가 매겨진 자막 줄들이다.
각 줄을 시청자가 읽기 좋은 자막으로 다듬어라:
- 맞춤법·띄어쓰기·오타 교정 (예: "됬어"→"됐어", "어떻해"→"어떡해", "않되"→"안 돼")
- 명백한 반복 제거 (예: "밥 먹었어? 밥 먹었어? 밥 먹었어?" → "밥 먹었어?")
- 말더듬·파편 정리, 자연스러운 구두점 추가
- 문맥상 명백한 오인식만 교정 (앞뒤 문맥으로 확실할 때만)
- 바로 앞 줄과 완전히 중복되면 빈 문자열("")로 둔다

말맛 보존 (중요):
- 예능 자막이다. 구어체·반말·유행어·감탄사는 그대로 살려라 ("ㅋㅋ", "대박", "재밌어").
- 맞춤법만 고치고, 문어체나 존댓말로 바꾸지 마라. 말투를 표준어로 다듬지 마라.

엄격한 규칙:
- 번호(n)는 절대 바꾸지 마라. 입력한 모든 번호를 그대로 출력한다.
- 없는 내용을 지어내거나 요약·의역하지 마라. 정제(cleanup)만 한다.
- 원래 발화의 뜻을 바꾸지 마라."""

RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "n": {"type": "INTEGER"},
            "text": {"type": "STRING"},
        },
        "required": ["n", "text"],
    },
}


def _client() -> "genai.Client":
    return genai.Client(vertexai=True, project=PROJECT, location=LOCATION)


def load_glossary() -> dict:
    """Optional core/glossary.json: {"오인식": "정답"}. Pins fixes the LLM can't guess
    from text alone (homophones, names) — e.g. STT "지약" that is actually "쥐약"."""
    path = Path(__file__).parent / "glossary.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _apply_glossary(text: str, glossary: dict) -> str:
    for wrong, right in glossary.items():
        if wrong:
            text = text.replace(wrong, right)
    return text


def _apply_glossary_words(words: list, glossary: dict) -> list:
    """Apply the glossary to each word token too, so word-level karaoke (\\k) in the render
    shows the same corrected text as the sentence. Single-word fixes (names) apply; multi-
    word glossary entries just don't match a lone token (harmless). Returns new dicts."""
    if not words or not glossary:
        return words or []
    out = []
    for w in words:
        w2 = dict(w) if isinstance(w, dict) else w
        if isinstance(w2, dict) and isinstance(w2.get("word"), str):
            w2["word"] = _apply_glossary(w2["word"], glossary)
        out.append(w2)
    return out


def refine_segments(segments: list[dict]) -> list[dict]:
    """Return segments with cleaned `text`, same length/order/timestamps as input."""
    client = _client()
    glossary = load_glossary()
    refined = [dict(s) for s in segments]  # copy; fall back to original text on failure

    # Feed the glossary to the model too (so it also fixes inflected forms), then
    # enforce it deterministically afterwards.
    system = SYSTEM
    if glossary:
        pairs = ", ".join(f'"{w}"→"{r}"' for w, r in glossary.items())
        system += f"\n\n용어 교정 사전(이 오인식은 반드시 오른쪽으로 고쳐라): {pairs}"

    for i in range(0, len(segments), BATCH):
        batch = segments[i:i + BATCH]
        # Number each batch LOCALLY (1..N), not globally. Models routinely renumber from 1
        # despite instructions; a global offset (batch 2 = 41..80) then matches nothing and
        # silently drops the whole batch's refinement. Local numbering + offset-back is robust.
        numbered = "\n".join(f"{j + 1}. {s['text']}" for j, s in enumerate(batch))
        try:
            resp = client.models.generate_content(
                model=MODEL,
                contents=numbered,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0.2,
                    response_mime_type="application/json",
                    response_schema=RESPONSE_SCHEMA,
                ),
            )
            rows = json.loads(resp.text or "[]")
            # Guard each row's `n` individually — one garbage/None value must not blow up the
            # whole comprehension and discard the entire batch's refinement.
            by_n: dict[int, str] = {}
            for r in rows:
                try:
                    by_n[int(r["n"])] = r.get("text", "")
                except (KeyError, TypeError, ValueError):
                    continue
            for j in range(len(batch)):
                n = j + 1  # local index the model was shown
                if n in by_n:
                    refined[i + j]["text"] = _apply_glossary(by_n[n].strip(), glossary)
            done = min(i + BATCH, len(segments))
            print(f"   refined {done}/{len(segments)}")
        except Exception as e:
            # Keep this batch's original text (glossary still applied) rather than losing it.
            for j in range(len(batch)):
                refined[i + j]["text"] = _apply_glossary(batch[j]["text"], glossary)
            print(f"   (batch {i}-{i + len(batch)} failed, kept raw: {str(e)[:120]})")

    # Word-level timestamps ride along on the copied dicts (dict(s) above), which the render
    # uses for \k karaoke. Apply the glossary to those tokens too so the sung text matches
    # the cleaned sentence. (Gemini STT yields no words → this is a no-op there; whisper does.)
    if glossary:
        for r in refined:
            if r.get("words"):
                r["words"] = _apply_glossary_words(r.get("words"), glossary)

    return refined


def to_srt(segments: list[dict]) -> str:
    out = []
    idx = 1
    for s in segments:
        text = (s.get("text") or "").strip()
        if not text:  # dropped as redundant — no subtitle block
            continue
        out.append(f"{idx}\n{_ts(s['start'])} --> {_ts(s['end'])}\n{text}\n")
        idx += 1
    return "\n".join(out)


def _ts(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: python -m core.refine <pipeline_output.json> [--out <prefix>]")
        sys.exit(1)

    src = Path(sys.argv[1])
    out_prefix = "refined"
    if "--out" in sys.argv:
        out_prefix = sys.argv[sys.argv.index("--out") + 1]

    data = json.loads(src.read_text(encoding="utf-8"))
    segments = data["segments"] if isinstance(data, dict) else data
    print(f"정제 시작: {len(segments)} 세그먼트 · 모델 {MODEL} (Vertex AI {PROJECT}/{LOCATION})")

    refined = refine_segments(segments)

    out_dir = src.parent
    srt_path = out_dir / f"{out_prefix}_transcript.srt"
    json_path = out_dir / f"{out_prefix}_segments.json"
    srt_path.write_text(to_srt(refined), encoding="utf-8")
    json_path.write_text(json.dumps(refined, ensure_ascii=False, indent=2), encoding="utf-8")

    kept = sum(1 for s in refined if (s.get("text") or "").strip())
    print(f"완료: {kept}/{len(refined)} 자막 (중복 {len(refined) - kept} 제거)")
    print(f"  SRT : {srt_path}")
    print(f"  JSON: {json_path}")


if __name__ == "__main__":
    main()
