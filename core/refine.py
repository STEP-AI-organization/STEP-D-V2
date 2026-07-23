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
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

# Windows consoles default to cp949 and crash on non-Latin/emoji output.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
# Seoul — transcripts can carry personal info; keep processing in-country (data residency).
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
BATCH = 40  # segments per Gemini call — small enough to stay coherent, big enough to be cheap
# 배치 병렬 워커 수. Gemini Vertex는 몇 개까지 잘 소화(STT_WORKERS와 유사). 너무 크면 429.
REFINE_WORKERS = int(os.environ.get("REFINE_WORKERS") or 4)

SYSTEM = """너는 한국어 예능/방송 자막 정제 전문가다.
입력은 자동 음성 인식(STT) 결과로, 번호가 매겨진 자막 줄들이다.
각 줄을 시청자가 읽기 좋은 자막으로 다듬고, 발화자(speaker)를 라벨링한다.

정제(cleanup):
- 맞춤법·띄어쓰기·오타 교정 (예: "됬어"→"됐어", "어떻해"→"어떡해", "않되"→"안 돼")
- 명백한 반복 제거 (예: "밥 먹었어? 밥 먹었어? 밥 먹었어?" → "밥 먹었어?")
- 말더듬·파편 정리, 자연스러운 구두점 추가
- 문맥상 명백한 오인식만 교정 (앞뒤 문맥으로 확실할 때만)
- 바로 앞 줄과 완전히 중복되면 빈 문자열("")로 둔다

말맛 보존 (중요):
- 예능 자막이다. 구어체·반말·유행어는 그대로 살려라 ("대박", "재밌어", "ㅋㅋ").
- 맞춤법만 고치고, 문어체나 존댓말로 바꾸지 마라. 말투를 표준어로 다듬지 마라.

감탄사·필러 삭제 (2026-07-23 · 노이즈 감소):
- **단독 감탄사·필러 세그먼트는 빈 문자열("")로 삭제**: "오", "아", "음", "어", "네", "예",
  "야", "우와" 같은 단일 감탄사/짧은 리액션만 있는 세그먼트.
- **문장 중간·앞에 붙은 감탄사는 삭제**: "오 대박이네" → "대박이네", "아 그래서" → "그래서".
- **의미 있는 반응은 유지**: "우와 진짜 놀랐어" → 유지 (뒤에 실질 발화).
- **웃음소리는 삭제**: "ㅋㅋㅋ", "하하하" 단독은 빈 문자열.
- 의도: 이후 서사·쇼츠 추천 파이프라인에 노이즈 안 주기 위함.

발화자 라벨(speaker) — 문맥으로 추정:
- 자막에서 상대를 부르는 이름/호칭, 자기 소개, 이전 대사의 반응 대상 등을 단서로 삼는다.
- 확신할 때만 실명/별명을 채운다 (예: "이영자", "김수현", "아이유").
- 유명 연예인·아이돌·MC·정치인·스포츠 선수 등 공인은 자막 맥락과 세계지식으로 확실히 알아본다면
  주저 말고 실명을 붙여라. M1/F1 폴백은 자막으로도 특정 안 되는 **일반인·비공인·게스트**용이다.
- 확신 못 하면 anonymous 라벨: 남성이면 "M1", "M2"…, 여성이면 "F1", "F2"…, 성별도 불명이면 "?"
- 같은 배치 안에서는 같은 발화자에게 같은 라벨을 일관되게 부여한다.
- 나레이션/자막해설/OFF 음성은 "NARR".

호칭 기반 대사 문맥 추론 (2026-07-23 강화 · 사용자 방향):
- **호칭 패턴 감지**: 이전 대사에서 "지연아", "지연씨", "지연이", "지연 님" 같은 호칭이 나오면
  다음 대사의 speaker 후보 = "지연" (그 이름 붙이는 사람 아님 · 그 이름 불린 사람이 다음 발화).
- **자기소개**: "저는 은규입니다", "제 이름은 민경이에요" → 그 발화의 speaker = 은규/민경.
- **응답 관계**: "지연아 어떻게 생각해?" → 다음 대사가 답변이면 그 speaker = 지연.
- **명단 밖 이름이라도** 대사에서 호칭·자기소개로 명확하면 실명을 붙여라 (cast_registry 있으면
  거기 이름 우선, 없으면 대사에서 나온 이름 그대로).
- 이 추론이 성공하면 anonymous(M1/F1) 대신 실명 · 같은 인물이 여러 세그에 걸치면 라벨 유지.

엄격한 규칙:
- 번호(n)는 절대 바꾸지 마라. 입력한 모든 번호를 그대로 출력한다.
- 없는 내용을 지어내거나 요약·의역하지 마라. 정제(cleanup)만 한다.
- 원래 발화의 뜻을 바꾸지 마라.

Return ONLY a valid JSON array. Do not add prose, markdown, or code fences. Example:
[{"n":1,"text":"정제된 대사","speaker":"M1"},{"n":2,"text":"다음 대사","speaker":"F1"}]"""


def _parse_json_array_recover(raw: str) -> list[dict]:
    """느슨한 JSON 배열 파서. response_schema 없이 프롬프트만으로 형식 강제할 때 필요.

    실패 케이스 대응:
    (a) MAX_TOKENS로 마지막 객체가 잘림 → 마지막 완전 `}` 위치까지 잘라 `]`로 재구성
    (b) 앞뒤 프로즈/코드펜스 → 첫 `[`부터 시도, 실패하면 마지막 `]`까지
    (c) 완전 파싱 실패 → 빈 배열 (배치 통째 유실 방지, 원문 유지로 폴백)

    ⚠️ AENA 레퍼런스 원칙: response_schema 쓰면 잘림 시 파싱 실패로 배치 통째 유실.
    프롬프트+파서 조합이 실무적으로 더 안전.
    """
    if not raw:
        return []
    s = raw.strip()
    # code fence 제거 (```json ... ``` 나올 때)
    if s.startswith("```"):
        # first newline 이후부터, closing ``` 앞까지
        first_nl = s.find("\n")
        if first_nl >= 0:
            s = s[first_nl + 1:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3].rstrip()
    # 첫 `[` 앞의 프로즈 제거
    lb = s.find("[")
    if lb > 0:
        s = s[lb:]
    # 시도1: 그대로
    try:
        v = json.loads(s)
        return v if isinstance(v, list) else []
    except json.JSONDecodeError:
        pass
    # 시도2: 마지막 완전 `}` 뒤에서 잘라 배열 닫기 (MAX_TOKENS 잘림 복구)
    last_close = s.rfind("}")
    if last_close > 0:
        candidate = s[: last_close + 1] + "]"
        try:
            v = json.loads(candidate)
            return v if isinstance(v, list) else []
        except json.JSONDecodeError:
            pass
    # 시도3: 마지막 `]` 위치 이전으로 컷 (뒤에 프로즈 붙은 경우)
    last_bracket = s.rfind("]")
    if last_bracket > 0:
        try:
            v = json.loads(s[: last_bracket + 1])
            return v if isinstance(v, list) else []
        except json.JSONDecodeError:
            pass
    return []


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


def refine_segments(segments: list[dict], cast_registry: list[dict] | None = None) -> list[dict]:
    """Return segments with cleaned `text` + `speaker` label, same length/order/timestamps.

    배치들은 서로 독립이라 ThreadPoolExecutor로 병렬 호출. Gemini 모델 자체가 배치별 stateless.
    각 스레드는 자기 배치의 슬라이스 [i:i+BATCH]에만 write하므로 lock 불필요.

    cast_registry (사용자가 프로그램에 사전등록한 출연자 명단, primary source of truth)가 있으면
    speaker 라벨을 이 목록에서 매칭. 목록에 없는 인물처럼 보이면 M1/F1... fallback 유지 —
    사용자가 나중에 검토·추가할 수 있도록. STT 오인식(옥순→옥수, 정순→정선 등)까지 문맥으로
    복구할 것을 프롬프트에서 지시."""
    client = _client()
    glossary = load_glossary()
    refined = [dict(s) for s in segments]  # copy; fall back to original text on failure

    # Feed the glossary to the model too (so it also fixes inflected forms), then
    # enforce it deterministically afterwards.
    system = SYSTEM
    if glossary:
        pairs = ", ".join(f'"{w}"→"{r}"' for w, r in glossary.items())
        system += f"\n\n용어 교정 사전(이 오인식은 반드시 오른쪽으로 고쳐라): {pairs}"

    # 등록된 캐스트가 있으면 speaker 매칭의 primary source. 사용자가 프로그램 만들 때 넣은 명단이라
    # 이걸 우선 신뢰하되, 이 명단에 없는데 대사·문맥으로 새 사람이 나오는 것 같으면 fallback 라벨.
    cast_names: list[str] = []
    if cast_registry:
        for m in cast_registry:
            n = (m.get("name") or "").strip()
            if n:
                cast_names.append(n)
            for a in (m.get("aliases") or []):
                a = (a or "").strip()
                if a:
                    cast_names.append(a)
    if cast_names:
        joined = ", ".join(cast_names)
        system += (
            "\n\n등록된 출연자 명단(primary — speaker는 이 이름 중 하나를 우선 사용):\n"
            f"{joined}\n"
            "- STT 오인식 주의: 이 명단의 이름과 발음이 비슷하면 명단 이름으로 정규화 (예: 옥수→옥순, 정선→정순).\n"
            "- 대사에서 서로 부르는 호칭(예: 'XX 님', 'OO아,')이 명단에 있으면 그 답변자가 그 인물일 가능성 높음.\n"
            "- 명단에 없는데 확실히 다른 사람이 등장한 것 같으면 M1/M2/F1/F2... 유지 (사용자 검토용 flag)."
        )

    total_batches = (len(segments) + BATCH - 1) // BATCH
    if total_batches == 0:
        return refined

    print_lock = Lock()
    done_counter = {"n": 0}

    def _do_batch(i: int) -> bool:
        """한 배치 처리. True=성공, False=실패(원문 유지). i는 전역 오프셋."""
        batch = segments[i:i + BATCH]
        # Number each batch LOCALLY (1..N), not globally. Models routinely renumber from 1
        # despite instructions; a global offset (batch 2 = 41..80) then matches nothing and
        # silently drops the whole batch's refinement. Local numbering + offset-back is robust.
        numbered = "\n".join(f"{j + 1}. {s['text']}" for j, s in enumerate(batch))
        try:
            # 429/503 일시 오류는 제자리 백오프 재시도 — 정제 실패가 원문 그대로
            # 체크포인트에 구워지는(silent degrade) 것을 막는다.
            resp = call_with_retry(lambda: client.models.generate_content(
                model=MODEL,
                contents=numbered,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0.2,
                    response_mime_type="application/json",
                    # response_schema 제거 (2026-07-22 AENA 레퍼런스): 잘림 시 파싱 실패로
                    # 배치 통째 유실을 막기 위해 프롬프트 예시 + partial JSON 복구 파서로 대체.
                ),
            ))
            rows = _parse_json_array_recover(resp.text or "")
            # Guard each row's `n` individually — one garbage/None value must not blow up the
            # whole comprehension and discard the entire batch's refinement.
            by_n: dict[int, dict] = {}
            for r in rows:
                try:
                    by_n[int(r["n"])] = r
                except (KeyError, TypeError, ValueError):
                    continue
            for j in range(len(batch)):
                n = j + 1  # local index the model was shown
                row = by_n.get(n)
                if row:
                    refined[i + j]["text"] = _apply_glossary((row.get("text") or "").strip(), glossary)
                    sp = (row.get("speaker") or "").strip()
                    if sp:
                        refined[i + j]["speaker"] = sp
            with print_lock:
                done_counter["n"] += 1
                print(f"   refined batch {done_counter['n']}/{total_batches} (segments {i}..{i + len(batch) - 1})")
            return True
        except Exception as e:
            # Keep this batch's original text (glossary still applied) rather than losing it.
            for j in range(len(batch)):
                refined[i + j]["text"] = _apply_glossary(batch[j]["text"], glossary)
            with print_lock:
                done_counter["n"] += 1
                print(f"   (batch {i}-{i + len(batch)} failed, kept raw: {str(e)[:120]})")
            return False

    # 병렬 실행 — REFINE_WORKERS만큼 동시. 배치 순서는 결과에 영향 없음(각자 자기 슬라이스만).
    failed_batches = 0
    with ThreadPoolExecutor(max_workers=REFINE_WORKERS) as ex:
        futures = [ex.submit(_do_batch, i) for i in range(0, len(segments), BATCH)]
        for fut in as_completed(futures):
            if not fut.result():
                failed_batches += 1

    # 스로틀 폭풍으로 배치 20% 초과가 원문으로 남았다면, 그 결과를 체크포인트로 굳히지
    # 말고 실패시켜 잡 재시도(정제 단계 재실행)로 넘긴다. 소수 실패는 원문 유지로 충분.
    if failed_batches > total_batches * 0.2:
        raise RuntimeError(
            f"refine: {failed_batches}/{total_batches} batches kept raw STT text (>20%) — "
            "failing so the job retries instead of baking raw text into the checkpoint"
        )

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
