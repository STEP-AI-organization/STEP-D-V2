"""Template 사전 가공 · 원본의 프로그램별 텍스트/로고 제거 → 재사용 가능한 clean 캔버스.

사용자 지시 (2026-07-28):
"템플릿 미리 가공해두자 · 다른 프로그램에 쓰면 다른 프로그램에 글자 출현자 얼굴이 역할받으니깐"

접근:
- 원본 template: 방송사 완성작 (원 프로그램 로고/배지/자막 다 있음)
- 가공 후 clean: 구도·색·장식 그래픽·인물 자리는 유지 · **모든 텍스트 제거**
  (프로그램 로고·배지 라벨·자막·인용문 등)
- swap 파이프라인: clean 을 base 로 · face+caption 만 추가 · 원본 잔재 X

각 template 별 1회 실행 · cleaned_path 저장 · manifest 갱신.

사용:
  python scripts/thumbnail_preprocess_template.py           # 모든 미처리 template 가공
  python scripts/thumbnail_preprocess_template.py ref_001   # 특정 하나만
  python scripts/thumbnail_preprocess_template.py --force   # 이미 가공된 것 재가공
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from core.openai_client import edit as openai_edit
from core.models import IMAGE_PRO as MODEL

REF_DIR = pathlib.Path(__file__).resolve().parents[1] / "assets" / "thumbnail-reference"
MANIFEST = REF_DIR / "manifest.json"

PROMPT = (
    "이 방송사 유튜브 썸네일을 **어떤 프로그램에도 재사용 가능한 슬롯 template** 로 가공하라.\n"
    "다른 프로그램용 얼굴·자막·배경이 나중에 이 슬롯에 채워질 예정.\n\n"
    "**1) 자막·텍스트 → 슬롯 라벨로 교체 (지우지 말고 · 위치·스타일 유지 · 문구만 바꿈)**:\n"
    "- 원본 폰트·색·크기·pill 배경 그대로 유지 · **내부 텍스트만** 아래처럼 교체:\n"
    "  · 메인 카피 (하단 큰 자막) → '아래 메인'\n"
    "  · 부제 (메인 위 얇은) → '아래 부제'\n"
    "  · 인용문 (인물 옆 손글씨) → '인용'\n"
    "  · 배지 (상단 코너 pill) → '배지'\n"
    "  · 상단 큰 자막 → '위 제목'\n"
    "  · 프로그램/채널 로고 → '로고'\n"
    "- 원본 문구는 절대 남기지 마 · 위 라벨로만 표시\n\n"
    "**2) 인물 얼굴 → 사람 형체 실루엣 (identity 제거)**:\n"
    "- 인물의 자세·위치·크기·의상 실루엣은 그대로\n"
    "- 얼굴만 **부드러운 회색 실루엣 (사람 같은 형체 · 눈코입 없이)** 으로\n"
    "- 배경 실루엣 인물도 동일 처리\n\n"
    "**3) 배경 → 프로그램 무관 중립 (원본 촬영 현장 완전 제거)**:\n"
    "- 원본 배경 (촬영 세트·소파·부엌·조명 등 특정 프로그램 흔적) 완전 제거\n"
    "- **중립 스튜디오 톤 배경**: 어두운 그라디언트 (다크 네이비/차콜) 또는 부드러운 뉴트럴 회색\n"
    "- 배경이 인물 실루엣과 자막 슬롯을 방해하지 않고 · 어떤 프로그램 인물이든 어울림\n"
    "- 배경에서 프로그램 특정 오브젝트·문양·소품 인식 불가능\n\n"
    "**4) 유지 (변경 X)**:\n"
    "- 하트·화살표·도형 등 순수 그래픽 장식\n"
    "- 프레임 비율·구도·자막 상자 위치·실루엣 자세\n\n"
    "결과: 배경/얼굴/자막 모두 프로그램 무관 슬롯 · swap 이 어떤 프로그램이든 채워 완성."
)


def preprocess_one(src_path: pathlib.Path, out_path: pathlib.Path,
                    project: str | None = None) -> bool:
    """원본 방송사 썸네일 → 슬롯 라벨 template · OpenAI images.edit (2026-07-30 전환)."""
    img_bytes = openai_edit(images=[src_path.read_bytes()], prompt=PROMPT,
                             model=MODEL, size="1536x1024")
    if not img_bytes:
        return False
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(img_bytes)
    return True


def main() -> int:
    if not MANIFEST.exists():
        print(f"[FAIL] manifest 없음: {MANIFEST}", file=sys.stderr); return 1

    force = "--force" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    only_id = args[0] if args else None

    entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
    updated = 0
    for entry in entries:
        rid = entry.get("id")
        if only_id and rid != only_id:
            continue
        if entry.get("cleaned_path") and not force:
            print(f"[skip] {rid} · 이미 cleaned (--force 로 재가공)")
            continue
        src = REF_DIR.parent / entry["path"]
        if not src.exists():
            print(f"[skip] {rid} · src 없음: {src}", file=sys.stderr)
            continue
        out = REF_DIR / "cleaned" / f"{rid}_clean.png"
        print(f"[preprocess] {rid} → {out.name} ...", end=" ", flush=True)
        try:
            ok = preprocess_one(src, out)
        except Exception as e:
            print(f"FAIL · {str(e)[:120]}")
            continue
        if ok:
            entry["cleaned_path"] = f"assets/thumbnail-reference/cleaned/{rid}_clean.png"
            print("OK")
            updated += 1
        else:
            print("FAIL (empty response)")

    if updated:
        MANIFEST.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[done] {updated} entries updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
