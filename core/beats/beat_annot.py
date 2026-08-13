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
import re
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

from core.common.models import TEXT as MODEL
from core.common.retry import call_with_retry

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


# ── 참조 인물 명찰판 (Gemini 참조사진 방식 · 2026-08-13) ───────────────────────
# 등록 캐스트 사진(work/cast_photos/{이름}.jpg)을 한 장의 번호배지 격자로 합쳐, 매 beat
# Vision 콜에 **첫 이미지**로 붙인다. chyron·화면자막이 없어도 프레임 속 얼굴을 이 명찰판과
# 대조해 characters 에 실명을 찍게 하는 게 목적(→ speaker_rename 이 대사 화자까지 실명화).
# 이름 매핑은 이미지 라벨뿐 아니라 **프롬프트 텍스트("번호→이름")로도** 준다 — 프로덕션
# 워커 이미지에 한국어 폰트(assets/)가 없어도 위치 매핑이 성립하도록. 사진이 없으면 None →
# 기존과 동작·비용 완전 동일(회당 추가 콜 0). 이미지는 회차 내내 동일하므로 청크 안에서
# 프롬프트 캐시 접두로 재사용된다(비용 사실상 회차당 1장).
_FONT_DIR = Path(__file__).resolve().parents[2] / "assets" / "thumbnail-fonts"
_PHOTO_EXTS = (".jpg", ".jpeg", ".png", ".webp")


def _safe_stem(name: str) -> str:
    # 서버(content-pipeline.ts:1361)와 동일한 파일명 안전화: 슬래시·백슬래시·NUL만 치환.
    return re.sub(r"[/\\\x00]", "_", name).strip()[:60]


def _resolve_cast_photos(cast_photos_dir: Path, names: list[str]) -> list[tuple[str, Path]]:
    """등록 이름 목록 → (이름, 사진경로) 쌍. 이름 순서 유지 · 파일 없는 이름은 스킵."""
    if not cast_photos_dir or not cast_photos_dir.exists() or not cast_photos_dir.is_dir():
        return []
    by_stem: dict[str, Path] = {}
    for p in sorted(cast_photos_dir.iterdir()):
        if p.suffix.lower() in _PHOTO_EXTS:
            by_stem.setdefault(p.stem, p)
    pairs: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for nm in names:
        nm = (nm or "").strip()
        if not nm or nm in seen:
            continue
        p = by_stem.get(_safe_stem(nm)) or by_stem.get(nm)
        if p:
            pairs.append((nm, p))
            seen.add(nm)
    return pairs


def _board_font(size: int):
    from PIL import ImageFont
    for f in ("Pretendard-Bold.otf", "NotoSansKR-Black.otf", "BlackHanSans-Regular.ttf"):
        fp = _FONT_DIR / f
        if fp.exists():
            try:
                return ImageFont.truetype(str(fp), size)
            except Exception:
                pass
    try:
        return ImageFont.load_default()   # 한글은 못 그려도 번호 배지는 렌더됨
    except Exception:
        return None


def build_cast_board(cast_photos_dir: Path, names: list[str], out_dir: Path,
                     max_n: int = 16) -> Optional[tuple[bytes, list[str]]]:
    """등록 캐스트 사진을 번호배지 격자 한 장으로 합쳐 (jpeg bytes, 순서대로의 이름) 반환.

    사진이 하나도 없으면 None (→ 명찰판 미첨부, 기존 동작 유지).
    """
    pairs = _resolve_cast_photos(Path(cast_photos_dir), names)[:max_n]
    if not pairs:
        return None
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None

    cell, pad, lbl_h, badge = 200, 8, 30, 30
    cols = min(4, len(pairs))
    rows = (len(pairs) + cols - 1) // cols
    W = cols * cell + (cols + 1) * pad
    H = rows * (cell + lbl_h) + (rows + 1) * pad
    board = Image.new("RGB", (W, H), (245, 245, 247))
    draw = ImageDraw.Draw(board)
    lbl_font = _board_font(20)
    num_font = _board_font(26) or lbl_font

    ordered: list[str] = []
    for i, (nm, p) in enumerate(pairs):
        r, cc = divmod(i, cols)
        x = pad + cc * (cell + pad)
        y = pad + r * (cell + lbl_h + pad)
        try:
            im = Image.open(p).convert("RGB")
            w, h = im.size
            s = min(w, h)
            left, top = (w - s) // 2, (h - s) // 2
            im = im.crop((left, top, left + s, top + s)).resize((cell, cell))
            board.paste(im, (x, y))
        except Exception:
            draw.rectangle([x, y, x + cell, y + cell], fill=(210, 210, 214))
        n = str(i + 1)
        # 번호 배지 (좌상단) — 폰트 유무와 무관하게 위치 매핑 성립
        draw.rectangle([x, y, x + badge, y + badge], fill=(20, 20, 24))
        if num_font:
            draw.text((x + 9, y + 2), n, fill=(255, 255, 255), font=num_font)
        # 이름 라벨 (하단 바) — 폰트 있으면 한국어 이름도
        draw.rectangle([x, y + cell, x + cell, y + cell + lbl_h], fill=(20, 20, 24))
        if lbl_font:
            draw.text((x + 6, y + cell + 5), f"{n}. {nm}"[:16], fill=(255, 255, 255), font=lbl_font)
        ordered.append(nm)

    try:
        import io
        buf = io.BytesIO()
        board.save(buf, format="JPEG", quality=85)
        data = buf.getvalue()
    except Exception:
        return None
    # 디버그·재사용 캐시 (추가 비용 없음)
    try:
        (Path(out_dir) / "_cast_board.jpg").write_bytes(data)
    except Exception:
        pass
    return data, ordered


def _registry_names(cast_registry) -> list[str]:
    """cast_registry(list[dict{name,aliases}] | list[str]) → 대표 이름 목록(순서 유지·중복 제거).

    명찰판 라벨·프롬프트 roster 는 speaker_rename._in_registry 가 확정하는 것과 같은
    **대표 이름(name)** 을 써야 characters_visible → 대사 실명화까지 이어진다.
    """
    out: list[str] = []
    seen: set[str] = set()
    for c in (cast_registry or []):
        nm = c.get("name") if isinstance(c, dict) else c
        nm = str(nm).strip() if nm is not None else ""
        if nm and nm not in seen:
            out.append(nm)
            seen.add(nm)
    return out


CTX_RECENT = int(os.environ.get("BEAT_ANNOT_CTX_RECENT") or 12)   # 요약까지 붙일 최근 beat 수
CTX_MAX = int(os.environ.get("BEAT_ANNOT_CTX_MAX") or 400)        # 제목만이라도 붙일 최대 beat 수


def _mmss(sec: float) -> str:
    try:
        s = float(sec)
    except (TypeError, ValueError):
        return "0:00"
    return f"{int(s // 60)}:{int(s % 60):02d}"


def build_prior_context(beats: list[dict], upto: int) -> str:
    """0 ~ upto-1 번 beat 의 확정 결과를 누적 맥락 문자열로 만든다 (도미노).

    사용자 요청 (2026-08-07): "한 프레임만 평가하다 보니 맥락이 이어지지 않음.
    도미노 쌓아올리듯 앞 프레임 맥락을 계속 쌓자 (프롬프트 캐시 활용)."

    프롬프트 배치가 중요하다 — 이 블록은 [프로그램 정보] 바로 뒤, **beat 별 내용 앞**에
    온다. 그래야 연속한 호출들이 같은 접두를 공유해 프롬프트 캐시가 걸린다.
    (뒤에 두면 매 호출 접두가 달라져 캐시가 통째로 빗나간다.)

    무한 증식은 막는다: 오래된 것은 제목만, 최근 것만 요약까지.

    ⚠️ "최근 N개" 를 upto 기준 슬라이딩 창으로 잡으면 **캐시가 죽는다** — 창이 한 칸 밀릴
    때마다 앞쪽 줄에서 요약이 떨어져 나가 접두가 통째로 바뀐다. 실측: 청크 60↔64 공통
    접두가 50%(≈600토큰)까지 떨어져 Gemini 암묵 캐시 최소치(~1024토큰)에 미달했다.
    그래서 **CTX_RECENT 블록 경계에 정렬**한다 — 한 블록 안에서는 접두가 append-only 라
    캐시가 유지되고, 블록이 넘어갈 때만 한 번 끊긴다.
    """
    if upto <= 0:
        return ""
    lo = max(0, upto - CTX_MAX)
    # 상세(요약 포함) 구간 시작을 블록 경계에 고정 → 블록 안에서는 접두가 안 변한다
    detail_from = ((upto - 1) // CTX_RECENT) * CTX_RECENT if CTX_RECENT > 0 else upto
    lines: list[str] = []
    for i in range(lo, upto):
        b = beats[i]
        t = (b.get("title") or "").strip()
        if not t:
            continue
        head = f"b{i} {_mmss(b.get('start') or 0)} {t}"
        if i >= detail_from:
            s = (b.get("summary") or "").strip()
            who = " · ".join((b.get("characters_visible") or b.get("characters") or [])[:3])
            if s:
                head += f" — {s[:160]}"
            if who:
                head += f" [{who}]"
        lines.append(head)
    if not lines:
        return ""
    return "[지금까지의 흐름 — 앞 beat 들의 확정 결과]\n" + "\n".join(lines) + "\n"


def build_prompt_head(program_ctx_str: str, prior_ctx: str = "",
                      cast_board_names: Optional[list[str]] = None) -> str:
    """**호출 간 동일한** 부분만 모은 프롬프트 앞머리 = 프롬프트 캐시의 접두.

    ⚠️ 이게 요청의 **맨 앞** 파트여야 한다. 예전에는 이미지 파트를 먼저 넣었는데,
    그러면 호출마다 접두(=서로 다른 프레임)가 달라져 **캐시가 한 번도 안 걸린다.**
    순서는 [head 텍스트] → [명찰판 이미지] → [beat 프레임] → [beat 별 꼬리 텍스트].

    명찰판 안내는 회차 내내 고정이라 prior_ctx **앞**(프로그램 정보 바로 뒤)에 둔다 —
    prior_ctx 는 청크마다 늘지만 그 앞은 안 변해 접두가 유지된다.
    """
    body = ""
    if program_ctx_str:
        body += f"[프로그램 정보]\n{program_ctx_str}\n\n"
    if cast_board_names:
        roster = " · ".join(f"{i + 1}){nm}" for i, nm in enumerate(cast_board_names))
        body += (
            "[참조 인물 명찰판]\n"
            "아래 이미지들 중 **첫 번째**는 이 프로그램 등록 출연자 얼굴 사진판이다 "
            "(각 얼굴 좌상단 번호 배지 · 하단 이름).\n"
            f"번호→이름: {roster}\n"
            "beat 프레임 속 인물이 이 명찰판의 누군가와 **동일 인물**로 보이면 characters 에 그\n"
            "실명을 그대로 쓴다(추정 라벨 '여성 참가자 1' 대신). 명찰판에 없거나 동일인 확신이\n"
            "없으면 익명 라벨을 유지한다. 얼굴이 가려지거나 안 보이면 명찰판을 근거로 쓰지 않는다.\n\n"
        )
    if prior_ctx:
        body += prior_ctx + "\n"
    return body


def _build_prompt(beat: dict, program_ctx_str: str = "", prior_ctx: str = "") -> str:
    """head + tail 합본. 디버그 dump 용 (실제 호출은 둘을 나눠 보낸다)."""
    return build_prompt_head(program_ctx_str, prior_ctx) + build_prompt_tail(beat, bool(prior_ctx))


def build_prompt_tail(beat: dict, has_prior: bool = False) -> str:
    st = float(beat["start"]); en = float(beat["end"])
    dur = en - st
    stt = (beat.get("transcript") or "").strip()
    chars = beat.get("characters") or []
    src_kind = (beat.get("boundary", {}) or {}).get("start_kind", "unknown")
    body = (
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
    if has_prior:
        body += (
            "\n\n[맥락 이어붙이기 — 중요]\n"
            "위 '지금까지의 흐름' 은 같은 회차의 **앞 장면들**이다. 이 beat 을 그 흐름의 다음 칸으로 읽어라.\n"
            "- 인물: 앞에서 쓴 라벨을 **그대로** 쓴다. 같은 사람을 새 라벨로 부르지 말 것\n"
            "  (앞에 '여성 참가자 1' 이 있으면 계속 '여성 참가자 1'). 이름이 새로 확인되면 그때만 실명으로 바꾼다\n"
            "- 상황: 앞에서 시작된 사건·갈등·목표가 이 beat 에서 어떻게 되는지로 서술한다\n"
            "  (예: '앞서 신고를 미뤘던 인물이 결국 직접 현장으로 향한다')\n"
            "- 반복 금지: 앞 beat 과 똑같은 title/summary 를 다시 쓰지 말 것. 이 beat 에서 **새로 일어난 것**만\n"
            "- 단 프레임과 대사가 흐름과 어긋나면 **눈앞의 프레임·대사를 우선**한다 (장면이 바뀐 것일 수 있다)"
        )
    return body


def _annotate_one(idx: int, beat: dict, video: Path, out_dir: Path,
                   program_ctx_str: str, prior_ctx: str = "",
                   cast_board: Optional[bytes] = None,
                   cast_board_names: Optional[list[str]] = None) -> dict:
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

    # ⚠️ 파트 순서가 프롬프트 캐시를 좌우한다: [안정 헤드 텍스트] → [이미지] → [beat 별 꼬리].
    # 예전에는 이미지를 **맨 앞**에 넣어서, 호출마다 접두가 서로 다른 프레임으로 시작했다
    # → 공통 접두가 0바이트라 캐시가 한 번도 안 걸렸다. 헤드(프로그램 정보 + 누적 맥락)는
    # 한 청크 안에서 완전히 동일하고 다음 청크에선 몇 줄만 늘어나므로 접두 재사용이 된다.
    head = build_prompt_head(program_ctx_str, prior_ctx, cast_board_names)
    tail = build_prompt_tail(beat, bool(prior_ctx))
    parts: list = []
    if head:
        parts.append(types.Part.from_text(text=head))
    # 참조 인물 명찰판 = **첫 이미지** (head 안내가 "첫 번째"라고 지목). 회차 내내 동일.
    if cast_board:
        try:
            parts.append(types.Part.from_bytes(data=cast_board, mime_type="image/jpeg"))
        except Exception:
            pass
    for p, _ in frames_available:
        try:
            parts.append(types.Part.from_bytes(data=p.read_bytes(), mime_type="image/jpeg"))
        except Exception:
            pass
    prompt_text = head + tail
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
    parts.append(types.Part.from_text(text=tail))

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
    cast_registry: list | None = None,
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

    # ── 도미노 맥락 누적 (2026-08-07) ─────────────────────────────────────────
    # 예전에는 전 beat 을 한 번에 병렬로 던져서 서로를 전혀 몰랐다. 그래서 같은 인물이
    # beat 마다 다른 라벨이 되고, 앞에서 시작된 사건이 이어지지 않았다.
    #
    # 완전 순차로 바꾸면 맥락은 완벽하지만 병렬을 다 잃는다(실측 4배 느림). 그래서
    # **청크 단위 순차 + 청크 안 병렬**: 청크 N 은 청크 0..N-1 의 확정 결과를 본다.
    # 맥락 지연은 최대 (chunk-1) beat 이고 병렬은 그대로 유지된다.
    #
    # 프롬프트 캐시: 누적 맥락은 프롬프트 **앞쪽**(프로그램 정보 바로 뒤)에 있고 한 청크
    # 안에서는 동일하다 → 같은 접두를 공유해 캐시가 걸리고, 다음 청크는 그 접두에 몇 줄만
    # 덧붙는다. 맥락을 뒤에 두면 매 호출 접두가 달라져 캐시가 통째로 빗나간다.
    chunk = max(1, workers)
    use_ctx = (os.environ.get("BEAT_ANNOT_CTX") or "1") != "0"

    # ── 참조 인물 명찰판 (Gemini 참조사진 방식) — 등록 캐스트 사진이 있을 때만 첨부 ──
    # 회차 한 번만 만들어 모든 beat 콜에 공유(첫 이미지). 사진 없으면 None → 기존 동작.
    cast_board = None
    cast_board_names = None
    if (os.environ.get("BEAT_ANNOT_CAST_BOARD") or "1") != "0":
        # 이름 원천: cast_registry(대표 이름) 우선 · 없으면 program_context.cast 폴백.
        cast_names = _registry_names(cast_registry)
        if not cast_names and isinstance(program_context, dict):
            cast_names = [str(x).strip() for x in (program_context.get("cast") or []) if str(x).strip()]
        built = build_cast_board(out / "cast_photos", cast_names, out) if cast_names else None
        if built:
            cast_board, cast_board_names = built
            print(f"   beat annotate: 참조 명찰판 {len(cast_board_names)}명 첨부 "
                  f"({len(cast_board) // 1024}KB · {' · '.join(cast_board_names)})")

    print(f"   beat annotate: {len(beats)} beats · workers={workers} · "
          f"맥락누적 {'ON' if use_ctx else 'OFF'} (청크 {chunk})")
    ok = 0
    done = 0
    for c0 in range(0, len(beats), chunk):
        idxs = list(range(c0, min(c0 + chunk, len(beats))))
        prior = build_prior_context(beats, c0) if use_ctx else ""
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            futs = {ex.submit(_annotate_one, i, beats[i], video, out, pc_str, prior,
                              cast_board, cast_board_names): i
                    for i in idxs}
            results = {}
            for fut in as_completed(futs):
                i = futs[fut]
                try:
                    results[i] = fut.result()
                except Exception as e:
                    results[i] = {"idx": i, "error": str(e)[:150]}
        # 청크 안에서는 **원래 순서대로** 반영해야 다음 청크 맥락이 시간순으로 쌓인다
        for i in idxs:
            r = results.get(i) or {"idx": i, "error": "no result"}
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
