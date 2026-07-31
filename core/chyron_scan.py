"""화면 자막(chyron) 기반 화자→실명 매핑 (Layer 2).

프레임을 일정 간격으로 뽑아 Gemini Vision 으로 인물 이름 자막을 감지하고,
그 시각에 활성인 STT 세그의 speaker(SPEAKER_00 등) 와 짝지어 매핑을 학습한다.

예능은 인물 등장 씬에서 하단 이름표가 뜨고, 그 순간 발화자가 대개 그 인물이다.
여러 hit 을 모아 최빈 (speaker → name) 매핑을 확정 · 전체 세그에 rewrite.

cast_registry 가 있으면 그 안 이름만 확정 · 없으면 감지된 모든 이름을 후보로 (스모크용).
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DEFAULT_SAMPLE_SEC = 3.0
WORKERS = 6

GEMINI_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
GEMINI_LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
# chyron OCR · 짧은 텍스트 추출 (사용자: "제일 낮은거 쓰삼" 2026-07-31).
# ⚠️ gemini-2.5-flash-lite 는 asia-northeast3 미제공(404). asia-northeast3 에서 확인된
# 가장 저렴한 Vision 모델은 gemini-2.5-flash. 다른 리전 or 신규 모델 나오면 env 로 override.
MODEL = os.environ.get("GEMINI_CHYRON_MODEL") or "gemini-2.5-flash"

PROMPT = (
    "이 방송/예능 프레임에서 '화면에 박힌 사람 이름' 만 뽑아 names 배열로 반환하라.\n"
    "\n"
    "특별히 주의 (예능·연애 프로 흔한 스타일):\n"
    "- 화면 하단에 [이름 태그] + [대사 자막] 이 같은 라인에 붙어 있는 형태.\n"
    "  예) '백현 | 우연히 소속사에 캐스팅 제안이 왔습니다'\n"
    "  예) '우진 | 원래 이제 일을 하다가'\n"
    "  예) '민수 · 이거 진짜야?'\n"
    "  → 태그 부분(백현/우진/민수) 만 names 에 넣어라. 옆 대사는 제외.\n"
    "- 태그는 보통 색 박스·괄호·구분선(|, ·, /)으로 대사와 분리된다.\n"
    "\n"
    "포함:\n"
    "- 이름표(로워서드): 얼굴 아래 · 옆에 뜨는 성함 · 별명 · 직함 카드\n"
    "  예) '김철수', '김철수 · 42세 · 배우', '한의사 원규'\n"
    "- 게스트 소개 카드에 나오는 이름\n"
    "- 순위표 · 팀 표시에 나오는 이름\n"
    "- 위에 설명한 [이름 태그 + 대사] 하이브리드 자막의 태그\n"
    "\n"
    "제외:\n"
    "- 프로그램 제목(환승연애·나혼자산다 등), 회차 표시, 시즌명, 방송사 로고(디글·MBC 등)\n"
    "- 감정/상황 자막: '분노폭발', '경악', '충격', '헐', '대박', '레전드'\n"
    "- 대사 자체 (하이브리드 자막에서도 대사 부분은 제외 · 태그의 이름만)\n"
    "- 광고 · 브랜드 · 상표\n"
    "- 지명/장소명 · 시간표시\n"
    "- 한 글자만 있는 것\n"
    "\n"
    "이름 형태 뽑기: '한의사 원규' 처럼 직업+이름이면 '한의사 원규' 그대로. "
    "이름 없이 별칭만이면 (예 'MC') 제외. 이름이 확실할 때만.\n"
    "\n"
    "없으면 빈 배열. 중복 이름은 하나만."
)

SCHEMA = {
    "type": "OBJECT",
    "properties": {"names": {"type": "ARRAY", "items": {"type": "STRING"}}},
    "required": ["names"],
}


def _extract_frames_batch(video_path: str, sample_every_sec: float, out_dir: Path) -> list[tuple[float, Path]]:
    """비디오에서 sample_every_sec 간격으로 프레임 일괄 추출 (한 번의 ffmpeg 호출).
    반환: [(time_sec, frame_path)] · 실패 시 빈 리스트.
    """
    fps = 1.0 / sample_every_sec
    pattern = out_dir / "f_%06d.jpg"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error",
             "-i", video_path,
             "-vf", f"fps={fps},scale=iw-mod(iw\\,2):ih-mod(ih\\,2),format=yuvj420p",
             "-q:v", "3",
             str(pattern)],
            check=True,
        )
    except Exception as e:
        print(f"[chyron] frame batch extract 실패: {e}")
        return []
    frames = sorted(out_dir.glob("f_*.jpg"))
    # ffmpeg fps 필터는 첫 프레임을 t=0 에 · 이후 매 sample_every_sec 마다
    return [(round(i * sample_every_sec, 2), p) for i, p in enumerate(frames)]


_first_err_logged = False

_KOREAN_PARTICLES = (
    "이랑", "한테", "에게서", "께서", "부터", "까지", "보다", "처럼",
    "이랑", "이나", "만큼", "밖에",
    "은", "는", "이", "가", "을", "를", "의", "에", "도", "과", "와",
    "랑", "께", "야", "아", "님", "씨",
)


def _strip_particle(name: str) -> str:
    """한국어 조사·존칭 접미가 붙어있으면 잘라낸다. 이름 최소 2글자 유지.
    긴 접미부터 매칭 (에게서 > 에게 > 에)."""
    for p in sorted(_KOREAN_PARTICLES, key=len, reverse=True):
        if name.endswith(p) and len(name) > len(p) + 1:
            return name[:-len(p)]
    return name


def _detect_names(client, config, image_bytes: bytes) -> list[str]:
    global _first_err_logged
    from google.genai import types
    try:
        resp = client.models.generate_content(
            model=MODEL,
            contents=[types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"), PROMPT],
            config=config,
        )
        data = json.loads(resp.text or "{}")
        raw_names = [str(n).strip() for n in (data.get("names") or []) if isinstance(n, str) and n.strip()]
        # 조사·존칭 잘라내기 (예 "민경은" → "민경") · 대사 오탐 정리
        cleaned = []
        seen: set[str] = set()
        for n in raw_names:
            fixed = _strip_particle(n)
            if fixed and fixed not in seen:
                seen.add(fixed)
                cleaned.append(fixed)
        return cleaned
    except Exception as e:
        # 첫 실패 한 번만 로깅 (200콜이 다 실패해도 조용히 빈 리스트만 뱉지 않게)
        if not _first_err_logged:
            print(f"   [chyron] Vision 콜 실패 (첫 케이스만 로깅): {str(e)[:200]}")
            _first_err_logged = True
        return []


def scan_chyron_over_video(video_path: str, sample_every_sec: float = DEFAULT_SAMPLE_SEC) -> list[dict]:
    """비디오를 sample_every_sec 마다 sample · Vision 이름 감지 결과 list.
    반환: [{"time": t_sec, "names": [n1, n2, ...]}] · names 비어있으면 skip 여부는 상위 결정."""
    tmpdir = Path(tempfile.mkdtemp(prefix="chyron_"))
    frames = _extract_frames_batch(video_path, sample_every_sec, tmpdir)
    if not frames:
        return []
    print(f"[chyron] 프레임 추출 완료 · {len(frames)}장 · Vision 감지 시작")

    from google import genai
    from google.genai import types
    client = genai.Client(vertexai=True, project=GEMINI_PROJECT, location=GEMINI_LOCATION)
    config = types.GenerateContentConfig(
        temperature=0,
        response_mime_type="application/json",
        response_schema=SCHEMA,
        max_output_tokens=512,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )

    def process(item: tuple[float, Path]) -> dict:
        t, path = item
        try:
            data = path.read_bytes()
        except Exception:
            return {"time": t, "names": []}
        names = _detect_names(client, config, data)
        return {"time": t, "names": names}

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(process, frames))

    # 임시 프레임 정리
    for _, p in frames:
        try:
            p.unlink()
        except Exception:
            pass
    try:
        tmpdir.rmdir()
    except Exception:
        pass

    hits = [r for r in results if r.get("names")]
    print(f"[chyron] {len(frames)} 프레임 스캔 · {len(hits)} 프레임에서 이름 감지")
    return hits


def _seg_active_at(segments: list[dict], t: float, pad: float = 2.0) -> list[dict]:
    """시각 t (± pad) 안 활성 세그 (겹치는 세그 모두 반환)."""
    out = []
    for s in segments:
        try:
            st = float(s.get("start", 0)); en = float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if en < t - pad or st > t + pad:
            continue
        out.append(s)
    return out


def _levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _canonicalize_similar_names(hits: list[dict], max_edit: int = 1) -> tuple[list[dict], dict[str, str]]:
    """감지된 이름 전체 · vote 집계 · 편집거리 max_edit 이내에서 낮은 vote 이름을 높은 vote 이름으로 흡수.

    예: '현지' 가 30번, '현기' 가 2번 · 편집거리 1 → '현기' → '현지' 로 통합.
    반환: 정정된 hits, {alias: canonical} 매핑.
    """
    from collections import Counter
    name_counts: Counter = Counter()
    for h in hits:
        for n in (h.get("names") or []):
            if isinstance(n, str) and n.strip():
                name_counts[n.strip()] += 1

    # 짧은 이름부터 크게 · 자주 나오는 것을 canonical
    canonical: dict[str, str] = {}
    sorted_names = sorted(name_counts.items(), key=lambda x: (-x[1], x[0]))
    canon_list: list[tuple[str, int]] = []
    for name, cnt in sorted_names:
        # 이미 canonical 리스트에 편집거리 <= max_edit 인 이름 있으면 그 이름으로 흡수
        merged = False
        for c_name, c_cnt in canon_list:
            if abs(len(c_name) - len(name)) > max_edit:
                continue
            if _levenshtein(name, c_name) <= max_edit:
                canonical[name] = c_name
                merged = True
                break
        if not merged:
            canon_list.append((name, cnt))
            canonical[name] = name

    # 매핑이 자기 자신인 경우는 mapping에서 제외 (실제 변경만)
    real_map = {k: v for k, v in canonical.items() if k != v}

    # hits 안 names 리스트 rewrite
    new_hits = []
    for h in hits:
        new_names = []
        seen: set[str] = set()
        for n in (h.get("names") or []):
            if not isinstance(n, str) or not n.strip():
                continue
            fixed = canonical.get(n.strip(), n.strip())
            if fixed not in seen:
                seen.add(fixed)
                new_names.append(fixed)
        new_hits.append({**h, "names": new_names})

    return new_hits, real_map


def map_speakers_from_chyron(segments: list[dict], hits: list[dict], *,
                              pad_sec: float = 2.0,
                              registry: list[dict] | list[str] | None = None,
                              min_votes: int = 2,
                              canonicalize: bool = True) -> tuple[dict[str, str], list[str]]:
    """chyron hits × 세그 speaker 교차 → (speaker → name) 매핑 학습.

    각 hit 에 대해: 그 시각 활성 세그의 anon speaker → hit 안 이름 중 registry 우선 매칭.
    같은 (speaker, name) 여러 표 · 최빈 확정 (min_votes 이상).
    registry=None 이면 감지된 모든 이름 후보 (스모크용).

    반환: mapping {SPEAKER_00: "이름", ...}, flagged [등록 밖 이름들]
    """
    def in_registry(name: str) -> bool:
        if not registry:
            return True  # None 이면 다 통과 (스모크)
        for c in registry:
            names = ([c] if isinstance(c, str)
                     else [c.get("name"), *(c.get("aliases") or [])])
            for n in names:
                if n and str(n).strip() == name.strip():
                    return True
        return False

    # OCR 오탐 정정 · 편집거리 1 이내 낮은 vote → 높은 vote 이름으로 통합
    if canonicalize:
        hits, alias_map = _canonicalize_similar_names(hits, max_edit=1)
        if alias_map:
            print(f"   [chyron] 유사 이름 통합: {alias_map}")

    votes: dict[str, Counter] = defaultdict(Counter)
    all_names: set[str] = set()
    for h in hits:
        t = float(h.get("time", 0))
        names = [n for n in h.get("names", []) if isinstance(n, str) and n.strip()]
        if not names:
            continue
        all_names.update(names)
        active = _seg_active_at(segments, t, pad=pad_sec)
        anon_spks = {(s.get("speaker") or "").strip() for s in active}
        anon_spks = {s for s in anon_spks if s and s.startswith("SPEAKER_")}
        # 그 시각 활성 세그가 여러 anon speaker 라면 · 어느 이름이 어느 speaker 인지 애매
        # → 정확도 우선: anon speaker 1개 · 이름 후보 1개 일 때만 매핑 기록
        if len(anon_spks) != 1:
            continue
        spk = next(iter(anon_spks))
        registered = [n for n in names if in_registry(n)]
        # 이름 후보도 1개 확정일 때만 (여러 이름 뜨면 애매)
        if len(registered) != 1:
            continue
        votes[spk][registered[0]] += 1

    mapping: dict[str, str] = {}
    for spk, cnt in votes.items():
        best_name, best_c = cnt.most_common(1)[0]
        if best_c >= min_votes:
            mapping[spk] = best_name

    flagged = sorted(n for n in all_names if registry and not in_registry(n))
    return mapping, flagged


def apply_speaker_mapping(segments: list[dict], mapping: dict[str, str]) -> int:
    """segments 안 speaker 필드 in-place rewrite. 반환: 변경 개수."""
    n = 0
    for s in segments:
        sp = (s.get("speaker") or "").strip()
        if sp in mapping:
            s["speaker"] = mapping[sp]
            n += 1
    return n


def scan_per_seg(video_path: str, segments: list[dict], *,
                 workers: int = 6, prefer_start: bool = True) -> tuple[list[dict], dict]:
    """각 STT 세그의 (start 또는 mid) 프레임 1장을 뽑아 Vision 이 그 세그의 화자 이름을 판정.

    Sample interval 방식 대신 · 세그마다 자체 프레임 · 그 세그 대사도 프롬프트에 첨부해서
    "이 대사 옆에 붙은 이름 태그" 를 직접 물어본다. 결과가 세그별 이름 · 전역 매핑 불필요.

    prefer_start=True: 세그 start+0.3s (이름표는 발화 시작에 뜨는 경우 많음)
                False: 세그 mid

    반환: (수정된 segments (speaker 필드에 이름 부여), stats)
    """
    if not segments:
        return segments, {"scanned": 0, "assigned": 0}

    from google import genai
    from google.genai import types
    client = genai.Client(vertexai=True, project=GEMINI_PROJECT, location=GEMINI_LOCATION)

    schema = {
        "type": "OBJECT",
        "properties": {"name": {"type": "STRING"}},
        "required": ["name"],
    }
    config = types.GenerateContentConfig(
        temperature=0,
        response_mime_type="application/json",
        response_schema=schema,
        max_output_tokens=64,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )

    import subprocess, tempfile
    from pathlib import Path as _Path
    tmpdir = _Path(tempfile.mkdtemp(prefix="chyron_seg_"))

    def _extract_at(t: float, idx: int) -> _Path | None:
        out = tmpdir / f"s_{idx:06d}.jpg"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error",
                 "-i", video_path,
                 "-ss", f"{max(0.0, t):.2f}",
                 "-frames:v", "1",
                 "-vf", "scale=iw-mod(iw\\,2):ih-mod(ih\\,2),format=yuvj420p",
                 "-f", "image2", "-update", "1",
                 str(out)],
                check=True,
            )
            return out if out.exists() and out.stat().st_size > 0 else None
        except Exception:
            return None

    def _detect_seg_name(idx_seg: tuple[int, dict]) -> tuple[int, str]:
        i, seg = idx_seg
        try:
            st = float(seg.get("start", 0)); en = float(seg.get("end", 0))
        except (TypeError, ValueError):
            return i, ""
        t = st + 0.3 if prefer_start else (st + en) / 2.0
        frame = _extract_at(t, i)
        if not frame:
            return i, ""
        text = (seg.get("text") or "").strip()[:80]
        prompt = (
            "이 프레임에 화면 자막(대사 태그) 이 있으면, 대사 옆·앞에 붙은 인물 이름 태그만 name 필드에 짧게 답하라.\n"
            f"참고 대사(오디오 STT): '{text}'\n"
            "규칙:\n"
            "- 이름 태그 없거나 애매하면 name='' 로.\n"
            "- 조사(은/는/이/가) 붙지 말고 성함만.\n"
            "- 프로그램 제목·로고·상황자막(경악·헐 등) 은 제외.\n"
            "- 대사 자체를 이름으로 넣지 마라."
        )
        try:
            resp = client.models.generate_content(
                model=MODEL,
                contents=[types.Part.from_bytes(data=frame.read_bytes(), mime_type="image/jpeg"), prompt],
                config=config,
            )
            data = json.loads(resp.text or "{}")
            name = str(data.get("name") or "").strip()
            name = _strip_particle(name)
            return i, name
        except Exception as e:
            global _first_err_logged
            if not _first_err_logged:
                print(f"   [chyron-seg] Vision 실패: {str(e)[:200]}")
                _first_err_logged = True
            return i, ""
        finally:
            try:
                frame.unlink()
            except Exception:
                pass

    print(f"[chyron-seg] {len(segments)} 세그 · Vision 병렬(workers={workers})")
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(_detect_seg_name, list(enumerate(segments))))

    try:
        tmpdir.rmdir()
    except Exception:
        pass

    # 후처리 1: 한글 자모/음절만 유지 (예 "PE우진" → "우진")
    import re
    KOREAN_ONLY = re.compile(r"[^가-힯ᄀ-ᇿ㄰-㆏\s·]")
    cleaned_results = []
    for i, name in results:
        if not name:
            cleaned_results.append((i, ""))
            continue
        n = KOREAN_ONLY.sub("", name).strip()
        n = _strip_particle(n)
        cleaned_results.append((i, n))

    # 후처리 2: 편집거리 1 이내 유사 이름 통합 (낮은 vote → 높은 vote 로)
    from collections import Counter as _Counter
    name_counts: _Counter = _Counter(n for _, n in cleaned_results if n)
    canon: dict[str, str] = {}
    canon_list: list[str] = []
    for n, c in sorted(name_counts.items(), key=lambda x: (-x[1], x[0])):
        merged = False
        for cn in canon_list:
            if abs(len(cn) - len(n)) > 1:
                continue
            if _levenshtein(n, cn) <= 1:
                canon[n] = cn
                merged = True
                break
        if not merged:
            canon_list.append(n)
            canon[n] = n
    alias_map = {k: v for k, v in canon.items() if k != v}
    if alias_map:
        print(f"   [chyron-seg] 유사 이름 통합: {alias_map}")

    out = [dict(s) for s in segments]
    assigned = 0
    for i, name in cleaned_results:
        if name:
            final = canon.get(name, name)
            out[i]["speaker"] = final
            assigned += 1
    return out, {"scanned": len(segments), "assigned": assigned,
                  "unique_names": len(set(canon.values()))}


def apply_names_per_seg(segments: list[dict], hits: list[dict], pad_sec: float = 2.0) -> int:
    """세그별 · 그 시각 chyron 이 정확히 1명 이름 감지 → 그 세그 speaker 를 그 이름으로 강제 rewrite.

    전역 매핑(apply_speaker_mapping) 후에 실행 · 전역 매핑이 잘못 붙인 케이스를 세그별
    화면 신호로 정정. 예: PyAnnote SPEAKER_00 이 사실 여러 인물을 같은 라벨로 뭉쳤을 때,
    현재 시각 chyron 이 다른 이름을 명시하면 그걸 신뢰.

    조건: chyron hit 안 이름이 정확히 1개 이고, hit 시각이 세그 [start-pad, end+pad] 안이면
    그 세그 speaker = 그 이름. hit 여러 이름이면 애매하므로 skip.
    """
    if not segments or not hits:
        return 0
    n = 0
    for s in segments:
        try:
            st = float(s.get("start", 0)); en = float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        # 이 세그 시각에 겹치는 chyron hit 중 · 1명 이름만 있는 것들의 이름들 수집
        candidate_names: list[str] = []
        for h in hits:
            try:
                t = float(h.get("time", 0))
            except (TypeError, ValueError):
                continue
            if t < st - pad_sec or t > en + pad_sec:
                continue
            names = [x for x in (h.get("names") or []) if isinstance(x, str) and x.strip()]
            if len(names) == 1:
                candidate_names.append(names[0])
        if not candidate_names:
            continue
        # 후보들의 최빈 이름 · 세그 안 chyron 이 여러 다른 이름 뜨면 우세 이름만
        from collections import Counter
        best_name, cnt = Counter(candidate_names).most_common(1)[0]
        # 확정 임계: 그 이름이 세그 안 후보의 과반이면 rewrite (혼재 케이스 방어)
        if cnt * 2 < len(candidate_names):
            continue
        if s.get("speaker") != best_name:
            s["speaker"] = best_name
            n += 1
    return n
