"""Phase 1: Thumbnail Planner — AI가 '계획'만 JSON으로 출력.

입력: shorts_ctx, candidate_frames, program_info, cast_photos
출력: ThumbnailPlan JSON (배경/인물/자막/레이아웃 완전 명세)
AI는 '이미지 생성/합성' 도구 호출 안 함 · 계획만 세움.
"""

from __future__ import annotations

import json
import os
import pathlib
from typing import Any, Optional

from google import genai
from google.genai import types

from .presets import PRESETS, prompt_summary as presets_prompt_summary, get_preset

MODEL = "gemini-2.5-flash"
DEFAULT_LOCATION = "us-central1"

SYSTEM_INSTRUCTION = """너는 한국 방송사 편집팀의 썸네일 **기획자(Planner)**다.
입력(쇼츠 컨텍스트·후보 프레임·출연자 사진)을 보고, **최종 썸네일의 완전한 설계도(ThumbnailPlan JSON)**를 하나만 출력한다.
이미지 생성·합성 도구는 **없다**. 너의 일은 "어떤 배경, 어떤 인물, 어떤 자막, 어디에 배치"를 JSON으로 확정하는 것뿐.

──────────────────
[필수 포함 요소] (누락 시 계획 불완전 → 재시도)
1. **preset_id**: 아래 스타일 프리셋 중 하나 (프로그램 성격에 맞게 선택)
2. background: {mode: "frame_blur"|"ai_generate"|"gradient"|"solid", ...상세 파라미터}
3. person: {source: "frame"|"cast_photo", frame_id?, cast_name?, subject?, side, scale}
4. caption: {text, position, tone_tag, size_hint, font_role}
5. layout_hints: {person_side, caption_position, safe_zone_respected: true}
──────────────────

[배경 모드 선택 가이드]
- frame_blur: 가장 안전·빠름. 원본 프레임 블러 → 인물과 톤 일치. "원본 느낌 살리기" 좋음.
- ai_generate: 컨셉추얼한 배경 필요 시(감정·분위기 강조). 프롬프트에 **사람·텍스트 언급 금지**.
- gradient/solid: 브랜드 컬러·단색 강조 필요 시.

[인물 소스 선택 가이드]
- source="frame": 원본 프레임에서 rembg로 컷아웃. 실제 방송 화면 그대로 → 신뢰도 높음.
- source="cast_photo": castPhotos 폴더의 인물 사진 원본 → rembg. 얼굴 identity 100퍼센트 유지.

[여러 인물 (persons 배열) 사용 가이드]
- 이 쇼츠가 **여러 인물 간 대화·리액션·대립·삼각관계**를 다루면 persons 배열 사용.
- 예: 환승연애·연애전쟁 = 2~4명 · 예능 리액션 = 2~3명 · 인터뷰 = 1명.
- side: "left" · "left-mid" · "center" · "right-mid" · "right" 5구간.
- scale: 메인 화자·주목 인물 0.9~1.1 · 리액션 서브 0.5~0.7 (한블리 스타일: 큰 인물 + 작은 리액션 컷).
- z_index: 겹칠 때 앞뒤 · 큰 게 앞.
- persons 배열 있으면 person 필드 무시 (배열이 우선).

[자막 대원칙 · 반드시 지킬 것]
**썸네일 자막 = 핵심(이 쇼츠에서 실제로 뭐가 벌어지는지) + 어그로(궁금증·클릭 유도)**
둘 다 있어야 함. 감성 여운·정갈한 문구는 클릭 안 됨.

좋은 예 (핵심 + 어그로):
- "3년 만에 만난 전 남친" (핵심 "3년만 · 전 남친" + 어그로 "만남")
- "결국 이 커플 폭발" (핵심 "커플" + 어그로 "폭발")
- "환승 확정 순간" (핵심 "환승" + 어그로 "확정 순간")
- "폭탄 발언 나옴" (핵심 "발언" + 어그로 "폭탄")
- "이 사람 진심이었네" (핵심 "이 사람" + 어그로 "진심 확인")

나쁜 예 (감성만 · 뭐 벌어지는지 모름):
- "돌아갈까? 직진할까?" (질문만 · 핵심 없음)
- "사랑? 미련? 새로운 인연?" (감성 여운만)
- "흔들리는 마음" (감상)
- "다시 만날 수 있을까?" (막연)

**필수**: 이 쇼츠의 컨텍스트(shorts.title, description, cast_names)에서 **구체 사건·인물·결과** 하나를
자막에 담을 것. "감정 여운"은 예능 다큐용 · 리얼리티는 사건 명시.

[자막 톤 가이드 · 요즘 유튜브 (2025~2026) 실제 톤]
※ 아래 "좋은 예" 스타일로 · "나쁜 예"는 뉴스 앵커/올드 광고 톤이니 피할 것.

좋은 예 (짧고·구어·훅 강함):
- "이거 실화?" · "미친 반응" · "결국 터졌다" · "표정 봐"
- "잠깐 뭐라고?" · "이 사람 뭐야" · "웃음 참기 실패"
- "[EP.4] 폭탄 발언" · "▶ 진짜 결심" · "그거 알아?"
- "01. 첫 만남" · "▷ 만나자" · "…라고 씁니다"
- "설마 이걸?" · "역대급 리액션" (남용 금지) · "이 장면 미쳤음"
- 대괄호·화살표·말줄임표·물음표 활용 · 이모지는 1개까지 (❓⚠️🔥💥 등)

나쁜 예 (올드 · 뉴스 앵커 · 지양):
- "사랑? 미련? 새로운 인연?" (정갈한데 훅 없음)
- "감동의 순간" · "특별한 만남" · "따뜻한 이야기"
- "…의 눈물" · "…의 진심" (매체 리뷰 톤)

톤 태그 매핑 (지금 태그 유지 · 예시만 요즘식):
- 인용: 실제 대사 짧게 · 큰따옴표 없이 · ("나 진짜 못 참겠어" 정도)
- 훅: 궁금증 · 짧고 강함 ("이거 실화?", "설마 진짜?")
- 의문: 시청자 참여 ("너라면?", "이거 어떻게 봄?")
- 충격: 반전·놀람 ("결국 터짐", "그럼 그렇지")
- 기본: 짧은 상황·태그 ("[EP.4] 첫 만남", "▶ 결심")

[자막 길이·형식]
- 총 2~6단어 (한글 기준 · 8음절 이내 권장)
- 개행은 자연스러운 곳 (2~3어절씩)
- 물음표·느낌표·말줄임표·대괄호·화살표 O · 남용 X
- clickbait 어휘("충격!!!", "레전드", "미쳤음" 반복)는 피함

[레이아웃 규칙]
- 인물 좌측 → 자막 우측 (반대도 가능)
- 자막은 안전영역(60px 마진) 내에, 인물 얼굴 bbox와 IoU < 0.1
- 폰트: 예능=굴림/검정 계열(variety), 드라마=명조(drama), 뉴스=고딕(news)

[출력 형식] **오직 JSON 하나만** 출력. 마크다운 코드블록 금지. 설명 텍스트 금지.

예시 A · 단일 인물:
{
  "preset_id": "reaction",
  "background": {"mode": "ai_generate", "prompt": "밤 카페 · 진한 조명 대비", "style": "photo"},
  "person": {"source": "cast_photo", "cast_name": "원규", "side": "right", "scale": 1.0},
  "caption": {"text": "이거 실화?", "position": "auto", "tone_tag": "훅", "size_hint": "XL", "font_role": "impact"},
  "layout_hints": {"person_side": "right", "caption_position": "left", "safe_zone_respected": true}
}

예시 B · **여러 인물** (화자 2명 이상 · 리액션·대립 있으면 이 형식 필수):
{
  "preset_id": "reaction",
  "background": {"mode": "ai_generate", "prompt": "카페 실내 · 대화 자리", "style": "photo"},
  "persons": [
    {"source": "cast_photo", "cast_name": "원규", "side": "left", "scale": 1.0, "z_index": 1},
    {"source": "cast_photo", "cast_name": "지연", "side": "right", "scale": 0.9, "z_index": 0}
  ],
  "caption": {"text": "3년 만에 만남", "position": "middle", "tone_tag": "훅", "size_hint": "XL", "font_role": "impact"},
  "layout_hints": {"caption_position": "middle", "safe_zone_respected": true}
}"""


def build_planner_prompt(
    shorts_ctx: dict,
    candidate_frames: list[dict],
    program_info: dict,
    cast_photos: list[str],
    shorts_slice: dict | None = None,
) -> str:
    """Planner에게 줄 첫 user 프롬프트 구성."""
    frames_summary = []
    for f in candidate_frames[:8]:
        faces = f.get("faces", [])
        largest = max(
            (f2.get("bbox", [0, 0, 0, 0]) for f2 in faces),
            key=lambda b: (b[2] - b[0]) * (b[3] - b[1]),
            default=None,
        )
        frames_summary.append({
            "id": f["id"],
            "size": f["size"],
            "has_face": f["has_face"],
            "largest_face_ratio": f.get("largest_face_area_ratio", 0),
            "face_count": len(faces),
        })

    cast_list = ", ".join(cast_photos) if cast_photos else "없음"
    prog = program_info or {}

    # shorts 구간 화자 목록 (2명 이상이면 persons 배열 강제)
    speakers_in_shorts: list[str] = []
    if shorts_slice:
        seen: set[str] = set()
        for line in shorts_slice.get("transcript_lines", []) or []:
            if line.startswith("[") and "]" in line:
                sp = line[1:line.index("]")].strip()
                if sp and sp not in seen:
                    seen.add(sp); speakers_in_shorts.append(sp)

    multi_person_directive = ""
    if len(speakers_in_shorts) >= 2:
        multi_person_directive = (
            f"\n\n[**여러 인물 필수**] 이 쇼츠 구간에 화자 {len(speakers_in_shorts)}명 "
            f"({', '.join(speakers_in_shorts[:5])})이 대화·리액션 함. "
            f"**반드시 persons 배열로 이 화자들을 최소 2명 배치**. "
            f"person 단일 필드 쓰지 마. side: left/right 최소 · 3명 이상이면 left/center/right."
        )

    # shorts 구간 실 내용 블록 (자막 "핵심" 근거)
    slice_block = ""
    if shorts_slice:
        parts_s = [f"\n[**이 쇼츠 구간 안 실제 내용** · {shorts_slice.get('start')}~{shorts_slice.get('end')}s "
                   f"({shorts_slice.get('duration')}초) — 자막 핵심의 근거]"]
        nseg = shorts_slice.get("narrative_segment")
        if nseg:
            parts_s.append(f"  블록 제목: {nseg.get('title','')}")
            parts_s.append(f"  요약: {nseg.get('summary','')}")
            if nseg.get("emotional_tone"):
                parts_s.append(f"  감정 톤: {nseg['emotional_tone']}")
        km = shorts_slice.get("key_moments") or []
        if km:
            parts_s.append("  핵심 순간:")
            for k in km[:6]:
                parts_s.append(f"    - {k}")
        tl = shorts_slice.get("transcript_lines") or []
        if tl:
            parts_s.append("  실제 대사 (STT · 최대 30줄):")
            for line in tl[:30]:
                parts_s.append(f"    · {line}")
        sc = shorts_slice.get("scene_summaries") or []
        if sc:
            parts_s.append("  씬:")
            for s in sc:
                parts_s.append(f"    · {s}")
        slice_block = "\n".join(parts_s) + "\n"

    return (
        f"[쇼츠 정보]\n"
        f"  제목: {shorts_ctx.get('title', '')}\n"
        f"  설명: {shorts_ctx.get('description', '')}\n"
        f"  출연자: {', '.join(shorts_ctx.get('cast_names', [])) or '미상'}\n"
        + slice_block +
        f"\n[프로그램]\n"
        f"  제목: {prog.get('title', '')}\n"
        f"  코너: {prog.get('section', '')}\n"
        f"  분위기: {prog.get('mood', '')}\n"
        f"  시놉시스: {(prog.get('synopsis', '') or '')[:300]}\n\n"
        f"[후보 프레임 Top-{len(frames_summary)}]\n"
        f"{json.dumps(frames_summary, ensure_ascii=False, indent=2)}\n\n"
        f"[사용 가능 캐스트 사진]\n"
        f"{cast_list}\n\n"
        f"{presets_prompt_summary()}\n\n"
        + multi_person_directive + "\n\n"
        "위 정보를 종합해 **최적의 스타일 프리셋을 선택**하고 (preset_id) "
        "그 프리셋 톤에 맞는 **ThumbnailPlan JSON**을 하나만 출력하라.\n"
        "**자막 text 는 반드시 위 '이 쇼츠 구간 안 실제 내용'의 대사·핵심 순간·요약에서 뽑아라** "
        "(상상하지 마 · shorts.title/description 만으로 지어내지 마).\n"
        "프리셋의 font_role·tone·position은 그대로 따르되 · text 만 shorts 구간 근거로 새로 작성.\n"
        "출력은 JSON만. 마크다운/설명 금지."
    )


# ── JSON 스키마 (function calling이 아닌 구조화 출력용) ──────────────
THUMBNAIL_PLAN_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "preset_id": {
            "type": "STRING",
            "enum": list(PRESETS.keys()),
            "description": "스타일 프리셋 선택 (broadcast_official/magazine/reaction/music_show/news/documentary)",
        },
        "background": {
            "type": "OBJECT",
            "properties": {
                "mode": {"type": "STRING", "enum": ["frame_blur", "ai_generate", "gradient", "solid"]},
                "frame_id": {"type": "STRING"},
                "blur_px": {"type": "INTEGER", "minimum": 0, "maximum": 100},
                "prompt": {"type": "STRING"},
                "style": {"type": "STRING", "enum": ["cinematic", "illustration", "photo", "abstract"]},
                "palette_hint": {"type": "ARRAY", "items": {"type": "STRING"}},
                "colors": {"type": "ARRAY", "items": {"type": "STRING"}},
                "angle": {"type": "INTEGER"},
                "color": {"type": "STRING"},
            },
            "required": ["mode"],
        },
        "person": {
            "type": "OBJECT",
            "description": "단일 인물 (persons 배열 없을 때만 사용)",
            "properties": {
                "source": {"type": "STRING", "enum": ["frame", "cast_photo"]},
                "frame_id": {"type": "STRING"},
                "cast_name": {"type": "STRING"},
                "subject": {"type": "STRING"},
                "side": {"type": "STRING", "enum": ["left", "right", "center"]},
                "scale": {"type": "NUMBER", "minimum": 0.5, "maximum": 1.5},
                "style_prompt": {"type": "STRING"},
            },
            "required": ["source", "side", "scale"],
        },
        "persons": {
            "type": "ARRAY",
            "description": ("여러 인물 합성 (한블리·연애전쟁 스타일 · 2~4명). "
                            "이 배열 있으면 person 필드 무시. 각 인물 크기·위치 다르게."),
            "items": {
                "type": "OBJECT",
                "properties": {
                    "source": {"type": "STRING", "enum": ["frame", "cast_photo"]},
                    "frame_id": {"type": "STRING"},
                    "cast_name": {"type": "STRING"},
                    "subject": {"type": "STRING"},
                    "side": {"type": "STRING", "enum": ["left", "left-mid", "center", "right-mid", "right"]},
                    "scale": {"type": "NUMBER", "minimum": 0.4, "maximum": 1.3,
                        "description": "메인 인물 0.9~1.1 · 서브 인물 0.5~0.7"},
                    "z_index": {"type": "INTEGER", "description": "0=뒤 · 큰 값=앞 (겹칠 때)"},
                },
                "required": ["source", "side", "scale"],
            },
        },
        "caption": {
            "type": "OBJECT",
            "properties": {
                "text": {"type": "STRING"},
                "position": {"type": "STRING", "enum": ["top", "middle", "bottom", "auto"]},
                "tone_tag": {"type": "STRING", "enum": ["인용", "훅", "의문", "충격", "기본"]},
                "size_hint": {"type": "STRING", "enum": ["XL", "L", "M"]},
                "font_role": {"type": "STRING",
                    "enum": ["variety", "impact", "reaction", "cute", "handwrite", "brush",
                             "drama", "magazine", "news", "documentary", "music_show"]},
                "text_color": {"type": "STRING"},
                "outline_color": {"type": "STRING"},
            },
            "required": ["text", "position", "tone_tag", "size_hint", "font_role"],
        },
        "layout_hints": {
            "type": "OBJECT",
            "properties": {
                "person_side": {"type": "STRING", "enum": ["left", "right", "center"]},
                "caption_position": {"type": "STRING", "enum": ["top", "middle", "bottom", "left", "right", "auto"]},
                "safe_zone_respected": {"type": "BOOLEAN"},
            },
        },
    },
    "required": ["preset_id", "background", "person", "caption", "layout_hints"],
}


def generate_plan(
    media_dir: pathlib.Path,
    variant_id: str = "v1",
    shorts_context: dict | None = None,
    project: str | None = None,
    location: str = DEFAULT_LOCATION,
) -> dict:
    """Planner 단일 호출 → ThumbnailPlan dict 반환."""
    project = project or os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")

    # 컨텍스트 로드
    shorts_path = media_dir / "shorts_context.json"
    if shorts_context is not None:
        shorts_ctx = shorts_context
    elif shorts_path.exists():
        shorts_ctx = json.loads(shorts_path.read_text(encoding="utf-8"))
    else:
        # workdir에서 최소 컨텍스트 구성
        pc = media_dir / "program_context.json"
        if pc.exists():
            prog = json.loads(pc.read_text(encoding="utf-8"))
            shorts_ctx = {
                "program": prog,
                "cast_names": prog.get("cast", []),
                "title": prog.get("title", "쇼츠"),
                "description": "",
            }
        else:
            shorts_ctx = {"title": "쇼츠", "description": "", "cast_names": []}

    # 후보 프레임 로드 (tools.list_candidate_frames와 같은 로직)
    shot_dir = media_dir / "shot_frames"
    faces_path = media_dir / "faces.json"
    faces_data = json.loads(faces_path.read_text(encoding="utf-8")) if faces_path.exists() else {}
    face_by_frame = _index_faces_by_frame(faces_data)

    candidate_frames = []
    if shot_dir.exists():
        for p in sorted(shot_dir.glob("shot_*.jpg")):
            try:
                from PIL import Image
                with Image.open(p) as im:
                    w, h = im.size
            except Exception:
                continue
            faces = face_by_frame.get(p.name, [])
            largest = max(
                (f.get("bbox", [0, 0, 0, 0]) for f in faces),
                key=lambda b: (b[2] - b[0]) * (b[3] - b[1]),
                default=None,
            )
            largest_area_ratio = 0.0
            if largest:
                fw, fh = largest[2] - largest[0], largest[3] - largest[1]
                largest_area_ratio = (fw * fh) / max(1, w * h)
            candidate_frames.append({
                "id": p.stem,
                "path": str(p),
                "size": [w, h],
                "faces": faces,
                "largest_face_area_ratio": round(largest_area_ratio, 4),
                "has_face": bool(faces),
            })

    # 얼굴 큰 순 정렬
    candidate_frames.sort(key=lambda f: -f["largest_face_area_ratio"])

    # 캐스트 사진 목록
    cast_photos_dir = media_dir / "cast_photos"
    cast_photos = [p.stem for p in cast_photos_dir.glob("*")] if cast_photos_dir.exists() else []

    # 프로그램 정보
    program_info = shorts_ctx.get("program", {})

    # shorts 구간 실 내용 슬라이싱 (§자막 핵심 근거)
    shorts_slice = None
    shorts_meta = shorts_ctx.get("shorts") if isinstance(shorts_ctx.get("shorts"), dict) else None
    if not shorts_meta:
        # 스모크 편의: shorts 지정 없으면 narrative의 첫 segment 를 임시 사용
        nar = _safe_load(media_dir / "narrative.json", default={})
        if isinstance(nar, dict):
            segs = nar.get("segments", []) or []
            if segs:
                s0 = segs[0]
                shorts_meta = {"start": s0.get("start", 0), "end": s0.get("end", 60),
                                "title": s0.get("title", ""), "description": s0.get("summary", "")}
                shorts_ctx.setdefault("title", shorts_meta["title"])
                shorts_ctx.setdefault("description", shorts_meta["description"])
    if shorts_meta and shorts_meta.get("end", 0) > shorts_meta.get("start", 0):
        shorts_slice = load_shorts_slice(media_dir, shorts_meta)

    # 프롬프트 구성
    user_prompt = build_planner_prompt(shorts_ctx, candidate_frames, program_info, cast_photos, shorts_slice)

    # 벤치마크 이미지 (실 유튜브 방송사 썸네일) few-shot 첨부
    benchmark_parts: list[types.Part] = []
    bench_root = pathlib.Path(__file__).resolve().parents[2] / "assets" / "thumbnail-benchmark"
    if bench_root.exists():
        # 각 채널 폴더에서 2장씩 · 최대 8장 (토큰 관리)
        picks: list[pathlib.Path] = []
        for ch_dir in sorted(bench_root.iterdir()):
            if not ch_dir.is_dir():
                continue
            jpgs = sorted(ch_dir.glob("*.jpg"))
            picks.extend(jpgs[:2])
        for p in picks[:8]:
            try:
                benchmark_parts.append(types.Part.from_bytes(
                    data=p.read_bytes(), mime_type="image/jpeg"))
            except Exception:
                pass

    parts: list = list(benchmark_parts)
    if benchmark_parts:
        parts.append(types.Part.from_text(text=(
            "[위 이미지는 실제 방송사 유튜브 (JTBC·MBC·Netflix Korea) 최근 썸네일들이다. "
            "이 톤·자막 스타일·구도·색·인물 크기·기호 사용을 참고해서 계획을 짜라. "
            "\"올드한 뉴스 앵커 톤\"이 아니라 이런 실제 유행 톤으로.]\n\n"
        )))
    parts.append(types.Part.from_text(text=user_prompt))

    # Vertex Gemini 호출 (structured output)
    client = genai.Client(vertexai=True, project=project, location=location)
    cfg = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        response_mime_type="application/json",
        response_schema=THUMBNAIL_PLAN_SCHEMA,
        temperature=1.0,
        max_output_tokens=4096,
    )
    resp = client.models.generate_content(
        model=MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=cfg,
    )

    if not resp.text:
        raise RuntimeError("Planner returned empty response")

    plan = json.loads(resp.text)

    # Post-process: shorts 화자 2명 이상인데 Planner가 person 하나만 냈으면 · persons 자동 생성
    if shorts_slice and not (isinstance(plan.get("persons"), list) and len(plan["persons"]) >= 2):
        speakers = []
        seen: set[str] = set()
        for line in shorts_slice.get("transcript_lines", []) or []:
            if line.startswith("[") and "]" in line:
                sp = line[1:line.index("]")].strip()
                if sp and sp not in seen and sp not in ("NARR",) and not sp.startswith("M"):
                    seen.add(sp); speakers.append(sp)
        # 실제 castPhoto 있는 화자만 우선
        cast_dir = media_dir / "cast_photos"
        available_cast = set(p.stem for p in cast_dir.glob("*")) if cast_dir.exists() else set()
        cast_speakers = [s for s in speakers if s in available_cast]
        if len(cast_speakers) >= 2:
            # 최대 3명 · side: left/right or left/center/right
            picks = cast_speakers[:3]
            if len(picks) == 2:
                sides = ["left", "right"]; scales = [1.0, 0.85]
            else:
                sides = ["left", "center", "right"]; scales = [0.9, 1.0, 0.85]
            plan["persons"] = [
                {"source": "cast_photo", "cast_name": n, "side": s, "scale": sc, "z_index": i}
                for i, (n, s, sc) in enumerate(zip(picks, sides, scales))
            ]
            plan.setdefault("_meta", {})["persons_auto_added"] = {
                "reason": f"{len(speakers)} speakers detected · {len(cast_speakers)} with castPhotos",
                "picks": picks,
            }

    # 계획 저장 (디버깅/재현용)
    out_dir = media_dir / "thumbnails" / variant_id
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

    return plan


def load_shorts_slice(media_dir: pathlib.Path, shorts: dict) -> dict:
    """shorts.start~end 구간의 실제 대사·씬·narrative 슬라이싱 (Planner "핵심" 근거).

    shorts = {"start": float, "end": float, ...}
    반환: {"transcript_lines": [...], "narrative_segment": {...}, "key_moments": [...],
           "scene_summaries": [...], "duration": float}
    """
    start = float(shorts.get("start", 0.0))
    end = float(shorts.get("end", 0.0))
    if end <= start:
        return {}

    slice_data: dict = {"start": start, "end": end, "duration": round(end - start, 1)}

    # 1) refined.json → shorts 구간 안 대사 (speaker + text)
    refined = _safe_load(media_dir / "refined.json", default=[])
    trans_lines: list[str] = []
    if isinstance(refined, list):
        for seg in refined:
            s = float(seg.get("start", 0)); e = float(seg.get("end", 0))
            if e < start - 0.5 or s > end + 0.5:
                continue
            sp = seg.get("speaker", "") or ""
            tx = (seg.get("text") or "").strip()
            if tx:
                trans_lines.append(f"[{sp}] {tx}" if sp else tx)
    slice_data["transcript_lines"] = trans_lines[:30]  # 최대 30줄 (토큰 절약)

    # 2) narrative.json 해당 segment (shorts를 포함하는 segment 하나)
    nar = _safe_load(media_dir / "narrative.json", default={})
    if isinstance(nar, dict):
        for seg in nar.get("segments", []) or []:
            s = float(seg.get("start", 0)); e = float(seg.get("end", 0))
            if s <= start and e >= end:
                slice_data["narrative_segment"] = {
                    "title": seg.get("title"),
                    "summary": (seg.get("summary") or "")[:400],
                    "characters": seg.get("characters", [])[:5],
                    "emotional_tone": seg.get("emotional_tone"),
                    "locations": seg.get("locations", [])[:3],
                }
                # 이 shorts 구간에 걸치는 key_moments만
                km_all = seg.get("key_moments", []) or []
                slice_data["key_moments"] = km_all[:6]
                break

    # 3) scenes.json 겹침 씬 (요약만)
    sc = _safe_load(media_dir / "scenes.json", default=[])
    scene_summaries: list[str] = []
    if isinstance(sc, list):
        for s2 in sc:
            ss = float(s2.get("start", 0)); se = float(s2.get("end", 0))
            if se < start or ss > end:
                continue
            tx = (s2.get("text") or "").strip()
            if tx:
                scene_summaries.append(f"[{int(ss)}~{int(se)}s] {tx[:120]}")
    slice_data["scene_summaries"] = scene_summaries[:4]

    return slice_data


def _safe_load(p: pathlib.Path, default: Any) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except Exception:
        return default


def _index_faces_by_frame(faces_data: Any) -> dict[str, list[dict]]:
    """faces.json 다양한 구조 → frame 파일명 기준 인덱스."""
    idx: dict[str, list[dict]] = {}
    if isinstance(faces_data, dict):
        for det in faces_data.get("detections", []) or []:
            fname = det.get("frame") or det.get("file") or det.get("path", "")
            if isinstance(fname, str):
                fname = pathlib.Path(fname).name
            if not fname:
                continue
            idx.setdefault(fname, []).append({
                "bbox": det.get("bbox") or det.get("xyxy") or [0, 0, 0, 0],
                "name": det.get("name") or det.get("label"),
                "cluster": det.get("cluster") or det.get("cluster_id"),
            })
    return idx


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python -m core.thumbnail.planner <media_dir> [variant_id]")
        sys.exit(1)
    media_dir = pathlib.Path(sys.argv[1])
    variant_id = sys.argv[2] if len(sys.argv) > 2 else "v1"
    plan = generate_plan(media_dir, variant_id)
    print(json.dumps(plan, ensure_ascii=False, indent=2))