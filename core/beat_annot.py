"""각 beat 에 title/summary/scene_summary/hook 채우기 (계획서 GEBD-beat 3번 · Frame Analysis).

입력:
  beats:            build_beats_from_boundaries 산출 [{id, start, end, transcript, characters, ...}]
  video_path:       원본 mp4
  out_dir:          workdir · beat_frames/ 서브폴더에 프레임 저장
  program_context:  {title, section, moods, synopsis, ...} · Gemini 프롬프트에 삽입
  transcript:       (선택) refined STT · beat.transcript 이미 있으면 재사용

출력:
  beats 를 in-place 수정 · 신규 필드:
    title (30자 이내), summary (1-2문장), scene_summary, hook (한 종류)
    boundary.start_frame, boundary.mid_frame, boundary.end_frame (workdir 상대경로)

프레임 추출: 각 beat 시작 +0.3s · 중간 · 종료 -0.3s (ffmpeg -ss / -frames 1)
Vision 콜: 프레임 3장 + STT 요약 + program_context → response_schema JSON
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

from .models import TEXT as MODEL
from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"

_client_singleton: Optional[genai.Client] = None

def _client() -> genai.Client:
    global _client_singleton
    if _client_singleton is None:
        _client_singleton = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    return _client_singleton


HOOK_ENUM = ["반전", "감정고조", "돌직구", "질문", "정보성", "웃음", "갈등", "공감", "기타"]

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},           # 30자 이내
        "summary": {"type": "string"},         # 1-2문장 (프로그램 취지 안 서사)
        "scene_summary": {"type": "string"},   # 시각 변화·전환 요약
        "hook": {"type": "string", "enum": HOOK_ENUM},
        "characters": {"type": "array", "items": {"type": "string"}},
        # 프레임에 노출된 그래픽 자막 (chyron · 하단바 · 팝업 · CG) 원문 그대로 배열.
        # 검색 인덱스·태그 소스로도 downstream 에서 재사용.
        "on_screen_captions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "summary", "hook"],
}


def _ffmpeg_frame(video: Path, t_sec: float, out: Path, width: int = 640) -> bool:
    """t_sec 시각 프레임 1장 추출 · out 에 저장. -ss 는 -i 앞 (fast seek)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-ss", f"{max(0.0, t_sec):.3f}",
        "-i", str(video),
        "-frames:v", "1",
        "-vf", f"scale={width}:-2",
        str(out),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=30)
        return r.returncode == 0 and out.exists()
    except Exception:
        return False


def _build_prompt(beat: dict, program_ctx_str: str) -> str:
    st = float(beat["start"]); en = float(beat["end"])
    dur = en - st
    stt = (beat.get("transcript") or "").strip()
    chars = beat.get("characters") or []
    src_kind = (beat.get("boundary", {}) or {}).get("start_kind", "unknown")
    body = ""
    if program_ctx_str:
        body += f"[프로그램 정보]\n{program_ctx_str}\n\n"
    body += (
        f"[Beat 정보]\n"
        f"- 시각: {st:.1f}s → {en:.1f}s (총 {dur:.1f}s)\n"
        f"- 경계 유형: {src_kind}\n"
    )
    if chars:
        body += f"- 감지된 화자: {' · '.join(chars[:4])}\n"
    if stt:
        body += f"\n[Beat 안 발화]\n{stt[:1200]}\n"
    body += (
        "\n[요청]\n"
        "이 beat (프레임 + 위 대사 + 프로그램 배경) 를 종합해 아래 스키마로 JSON.\n"
        "(env BEAT_ANNOT_FRAMES=3 일 때만 start/mid/end 3장 · default 1장 = mid 만)\n"
        "\n"
        "**프레임 안 그래픽 자막(화면 위 CG · chyron · 하단바 · 팝업)을 최우선 근거로 활용**하라.\n"
        "예능 화면 자막은 편집자가 이미 그 순간의 훅·핵심을 정리해둔 신호. 대사·비주얼과 충돌하면\n"
        "화면 자막을 더 신뢰해서 title/hook 판단. 인물 이름·상황 요약·팝업 quote 다 포함.\n"
        "\n"
        "- title: 프로그램 문법 안에서 이 beat 의 서사 순간 (30자 이내 · 이모지 X)\n"
        "  · 화면 자막이 있으면 그 표현 톤·핵심어를 반영\n"
        "  · 예능/연애: '직업 공개 첫 리액션' '이별 회상하며 감정 흔들리는 순간'\n"
        "  · 금지: '여성이 앉아 대화한다' 같은 일반 관찰\n"
        "- summary: 이 beat 안에서 실제로 일어난 일 1-2문장 (누가·무엇을·어떤 반응)\n"
        "  · 화면 자막에 핵심 정보 있으면 반드시 포함\n"
        "- scene_summary: 시작 프레임 → 끝 프레임 시각 변화·전환 (없으면 '같은 컷 유지')\n"
        "  · 자막이 등장/변화하는 순간도 시각 변화로 기록\n"
        f"- hook: 다음 중 하나 · {' / '.join(HOOK_ENUM)}\n"
        "  · 화면 자막이 명시적으로 '반전' '충격' '폭소' 등 유도하면 그걸 따름\n"
        "- characters: 이 beat 실질 등장 인물\n"
        "  · 프로그램 정보의 '등록 인물' 이나 화면 자막/명찰에서 이름이 확인되면 **실명 사용** (예: '원규')\n"
        "  · 확실치 않으면 익명 라벨 (예: '여성 참가자 1', '남성 게스트')\n"
        "  · 자막에 직업·직책 표기가 있으면 그 신호도 반영 (예: '한의사 원규')\n"
        "- on_screen_captions: 프레임에서 읽힌 그래픽 자막 원문 배열 (오탈자 없이 · 없으면 빈 배열)\n"
        "\n"
        "정지 관찰형 caption 절대 금지 · 프로그램 서사 프레임 + 화면 자막 신호로."
    )
    return body


def _annotate_one(idx: int, beat: dict, video: Path, out_dir: Path,
                   program_ctx_str: str) -> dict:
    st = float(beat["start"]); en = float(beat["end"])
    dur = en - st
    if dur < 0.6:
        return {"idx": idx, "error": f"beat too short: {dur:.2f}s"}

    # 프레임 추출 (default: mid 1장만 · env BEAT_ANNOT_FRAMES=3 로 start+mid+end 3장).
    # 2026-07-31: chyron per-seg 스택으로 앞단이 실명·화면자막 확보 · beat_annot 은 요약만
    # 필요 · 프레임 1장으로 Vision 비용 3→1 (58% 절감).
    n_frames = int(os.environ.get("BEAT_ANNOT_FRAMES", "1"))
    fdir = out_dir / "beat_frames"
    fdir.mkdir(exist_ok=True)
    name = f"beat_{idx:04d}"
    t_start = st + min(0.3, dur * 0.1)
    t_mid = st + dur * 0.5
    t_end = en - min(0.3, dur * 0.1)
    p_start = fdir / f"{name}_start.jpg"
    p_mid = fdir / f"{name}_mid.jpg"
    p_end = fdir / f"{name}_end.jpg"

    if n_frames >= 3:
        ok_s = _ffmpeg_frame(video, t_start, p_start)
        ok_m = _ffmpeg_frame(video, t_mid, p_mid)
        ok_e = _ffmpeg_frame(video, t_end, p_end)
    else:
        # 1장 모드 (default): mid 만 · start/end 는 파일 없음 (None 처리)
        ok_s = False
        ok_m = _ffmpeg_frame(video, t_mid, p_mid)
        ok_e = False

    frames_available = [(p, ok) for p, ok in [(p_start, ok_s), (p_mid, ok_m), (p_end, ok_e)] if ok]
    if not frames_available:
        return {"idx": idx, "error": "no frames extracted"}

    parts: list = []
    for p, _ in frames_available:
        try:
            parts.append(types.Part.from_bytes(data=p.read_bytes(), mime_type="image/jpeg"))
        except Exception:
            pass
    prompt_text = _build_prompt(beat, program_ctx_str)
    # RECOMMEND_DEBUG_DUMP · beat_annot 프롬프트도 첫 beat 만 파일에 dump (참고용)
    _dump_dir = os.environ.get("BEAT_ANNOT_DEBUG_DUMP")
    if _dump_dir:
        try:
            from pathlib import Path as _P
            _p = _P(_dump_dir) / f"beat_annot_prompt_b{idx:03d}.txt"
            _p.parent.mkdir(parents=True, exist_ok=True)
            _p.write_text(f"# beat_annot · beat #{idx}\n# frames: {[p.name for p, ok in frames_available]}\n\n{prompt_text}", encoding="utf-8")
        except Exception:
            pass
    parts.append(types.Part.from_text(text=prompt_text))

    # Gemini 2.5+ 는 thinking tokens 도 max_output_tokens 에 포함 · 1024 는 thinking 에 다 소진.
    # (1) max_output_tokens 대폭 증가 · (2) thinking 끔 (schema JSON 이라 reasoning 불필요).
    cfg_kwargs = dict(
        response_mime_type="application/json",
        response_schema=SCHEMA,
        temperature=0.2,
        max_output_tokens=4096,
    )
    try:
        cfg_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
    except Exception:
        pass  # 옛 SDK 는 ThinkingConfig 없음 · 무시
    cfg = types.GenerateContentConfig(**cfg_kwargs)
    t0 = time.time()
    try:
        # call_with_retry 필수 — (1) usage 집계가 여기 안에만 있어서 직접 호출하면 비용이
        # 계기에서 통째로 빠진다. beat_annot 은 회당 최대 콜 소비처(58.6분 드라마 = 239콜)라
        # 누락 시 usage.json 이 실제의 극히 일부만 보고한다(2026-08-06 실측: 35콜로 보고).
        # (2) 429/503 재시도도 같이 붙어 일시 오류로 beat 하나를 통째로 잃지 않는다.
        resp = call_with_retry(
            lambda: _client().models.generate_content(model=MODEL, contents=parts, config=cfg))
    except Exception as e:
        return {"idx": idx, "error": f"gemini: {str(e)[:150]}",
                 "frames": {"start": p_start.name if ok_s else None,
                             "mid": p_mid.name if ok_m else None,
                             "end": p_end.name if ok_e else None}}
    elapsed = time.time() - t0

    text = (resp.text or "").strip()
    data: dict = {}
    parse_err = ""
    try:
        data = json.loads(text) if text else {}
    except Exception as e:
        parse_err = f"json: {e}"
        s, e2 = text.find("{"), text.rfind("}")
        if s >= 0 and e2 > s:
            try:
                data = json.loads(text[s:e2 + 1])
                parse_err = ""
            except Exception as e3:
                parse_err = f"brace: {e3}"

    err = ""
    if not data:
        try:
            cand = (resp.candidates or [None])[0] if resp.candidates else None
            fr = getattr(cand, "finish_reason", None)
        except Exception:
            fr = None
        err = f"empty/unparsed · finish={fr} · raw_len={len(text)} · parse={parse_err} · head={text[:120]!r}"

    return {
        "idx": idx,
        "elapsed_sec": round(elapsed, 2),
        "frames": {"start": p_start.name if ok_s else None,
                    "mid": p_mid.name if ok_m else None,
                    "end": p_end.name if ok_e else None},
        "annot": data,
        "error": err,
    }


def _serialize_program_ctx(pc: dict | None) -> str:
    if not isinstance(pc, dict):
        return ""
    parts = []
    if pc.get("title"): parts.append(f"제목: {pc['title']}")
    if pc.get("section"): parts.append(f"장르: {pc['section']}")
    if pc.get("moods"): parts.append(f"분위기: {' · '.join(pc['moods'])}")
    if pc.get("synopsis"): parts.append(f"시놉시스: {pc['synopsis'][:400]}")
    if pc.get("broadcaster"): parts.append(f"채널: {pc['broadcaster']}")
    if pc.get("currentInfo"): parts.append(f"회차: {pc['currentInfo']}")
    cast = pc.get("cast") or []
    if isinstance(cast, list) and cast:
        # 등록된 인물 이름 목록 · beat_annot 가 characters 필드에서 실명 매칭할 근거
        names = [str(x).strip() for x in cast if str(x).strip()]
        if names:
            parts.append(f"등록 인물: {' · '.join(names[:20])}")
    return "\n".join(parts)


def annotate_beats(
    beats: list[dict],
    video_path: str | Path,
    out_dir: str | Path,
    program_context: dict | None = None,
    workers: int = 4,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[dict]:
    """각 beat 에 title/summary/scene_summary/hook 채우고 boundary.*_frame 경로 기록.

    in-place 수정 · 원본 beats 배열 반환.
    Gemini 콜 실패 시 해당 beat 는 title="" 유지.
    """
    if not beats:
        return beats
    video = Path(video_path)
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    pc_str = _serialize_program_ctx(program_context)

    # client warmup (thread pool 경합 방지)
    try:
        _ = _client()
    except Exception:
        pass

    print(f"   beat annotate: {len(beats)} beats · workers={workers}")
    ok = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futs = {ex.submit(_annotate_one, i, b, video, out, pc_str): i for i, b in enumerate(beats)}
        done = 0
        for fut in as_completed(futs):
            i = futs[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {"idx": i, "error": str(e)[:150]}
            done += 1
            b = beats[i]
            if r.get("error"):
                print(f"     [!] beat #{i} annot 실패: {r['error']}")
            frames = r.get("frames") or {}
            bd = b.setdefault("boundary", {})
            if frames.get("start"):
                bd["start_frame"] = f"beat_frames/{frames['start']}"
            if frames.get("mid"):
                bd["mid_frame"] = f"beat_frames/{frames['mid']}"
            if frames.get("end"):
                bd["end_frame"] = f"beat_frames/{frames['end']}"
            ann = r.get("annot") or {}
            if isinstance(ann, dict) and ann:
                if ann.get("title"): b["title"] = str(ann["title"])[:60]
                if ann.get("summary"): b["summary"] = str(ann["summary"])[:400]
                if ann.get("scene_summary"): b["scene_summary"] = str(ann["scene_summary"])[:200]
                if ann.get("hook"): b["hook"] = str(ann["hook"])
                if isinstance(ann.get("characters"), list):
                    # 기존 characters (dominant speaker) 는 유지 · 시각 감지 인물은 별도 필드
                    b["characters_visible"] = [str(x)[:40] for x in ann["characters"][:6]]
                if isinstance(ann.get("on_screen_captions"), list):
                    b["on_screen_captions"] = [str(x)[:100] for x in ann["on_screen_captions"][:10] if str(x).strip()]
                ok += 1
            if on_progress:
                on_progress(done, len(beats))
    print(f"   beat annotate: {ok}/{len(beats)} 성공")
    return beats
